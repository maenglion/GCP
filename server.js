    // ✅ 완전히 수정된 server.js — TTS + CORS 오류 해결 (gRPC 방식으로 Google TTS 호출)

    import express from 'express';
    import fetch from 'node-fetch';
    import cors from 'cors';
    import dotenv from 'dotenv';
    import admin from 'firebase-admin';
    // import fs from 'fs'; // fs 모듈은 이제 필요 없습니다. (삭제 가능)
    // import path from 'path'; // path 모듈은 이제 필요 없습니다. (삭제 가능)
    import { fileURLToPath } from 'url';
    import { TextToSpeechClient } from '@google-cloud/text-to-speech';
    import speech from '@google-cloud/speech';
    import mysql from 'mysql2/promise'; // ⭐⭐ 이 줄 추가 ⭐⭐

    // __filename, __dirname도 이제 서비스 계정 파일 경로에 사용되지 않으므로 삭제 가능
    // const __filename = fileURLToPath(import.meta.url);
    // const __dirname = path.dirname(__filename);

    const app = express();
    // Cloud Run은 process.env.PORT 환경 변수를 통해 포트를 제공합니다.
    // 로컬 테스트를 위해 기본값 3000을 사용하거나 8080으로 변경하는 것이 일반적입니다.
    const port = process.env.PORT || 8080; // Cloud Run 기본 포트는 8080
    dotenv.config();

    const allowedOrigins = [
      'http://localhost:5500',
      'http://127.0.0.1:5500',
      'https://lozee.netlify.app',
      'https://example.com',
      'https://postman.com',
      // Cloud Run 배포 후 할당되는 도메인도 필요시 여기에 추가
      `https://lozee-backend-838397276113.asia-northeast3.run.app`, // ⭐⭐ Cloud Run URL 추가 ⭐⭐
      undefined // Postman 등 origin이 없는 요청을 허용하기 위함
    ];

    app.use(cors({
      origin: function (origin, callback) {
        if (!origin || allowedOrigins.includes(origin)) {
          callback(null, true);
        } else {
          console.warn('❌ CORS 차단된 요청:', origin);
          callback(new Error('Not allowed by CORS'));
        }
      },
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      credentials: true
    }));


    app.options('*', cors());

    // ✅ Firebase Admin을 환경변수 기반으로 초기화
    admin.initializeApp();

    // ✅ TTS/STT 클라이언트 초기화 로직 변경
    // GCP 환경 (Cloud Run)에서는 서비스 계정을 Cloud Run 서비스에 연결하여
    // 암묵적 인증을 사용하므로, 별도의 키 파일 로딩 로직이 필요 없습니다.
    // 필요한 권한은 Cloud Run 서비스에 연결된 서비스 계정에 부여합니다.
    let ttsClient = null;
    let sttClient = null;

    try {
      ttsClient = new TextToSpeechClient(); // credentials 옵션 제거
      sttClient = new speech.SpeechClient(); // credentials 옵션 제거
      console.log('✅ TTS/STT 클라이언트 Google Cloud Implicit Authentication으로 초기화 성공');
    } catch (error) {
      console.warn('⚠️ TTS/STT 클라이언트 초기화 실패 (Implicit Authentication):', error.message);
      console.warn('⚠️ TTS/STT 기능은 비활성화됩니다. Cloud Run 서비스 계정에 권한이 부여되었는지 확인하세요.');
    }

    // ⭐⭐ 데이터베이스 연결 풀 설정 ⭐⭐
    let dbPool; // 전역적으로 사용하기 위해 선언

    async function connectToDatabase() {
      try {
        dbPool = mysql.createPool({
          host: process.env.DB_HOST,         // Cloud SQL 인스턴스의 연결 정보 (환경 변수)
          user: process.env.DB_USER,         // Cloud SQL 사용자명 (환경 변수)
          password: process.env.DB_PASSWORD, // Cloud SQL 비밀번호 (환경 변수)
          database: process.env.DB_NAME,     // 사용할 데이터베이스 이름 (환경 변수)
          waitForConnections: true,
          connectionLimit: 10,               // 동시에 유지할 연결 수
          queueLimit: 0                      // 연결 대기열에 들어갈 최대 요청 수 (0 = 무제한)
        });
        console.log('✅ MySQL 데이터베이스 연결 풀 생성 완료');
      } catch (error) {
        console.error('❌ MySQL 데이터베이스 연결 풀 생성 실패:', error);
        // 서버가 DB 연결 없이는 동작하지 않아야 한다면 여기서 process.exit(1) 등을 고려
      }
    }


    app.use(express.json({ limit: '10mb' }));
    app.use(express.raw({ type: 'audio/wav', limit: '10mb' }));
   
    app.use("/api/gpt-vision", (req, res) => {
  res.status(501).json({ message: "해당 기능은 곧 지원 예정입니다." });
});

    async function verifyFirebaseToken(req, res, next) {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
      try {
        const decoded = await admin.auth().verifyIdToken(authHeader.split('Bearer ')[1]);
        req.user = decoded;
        next();
      } catch (e) {
        console.error('Firebase 토큰 인증 실패:', e);
        res.status(403).json({ error: 'Unauthorized' });
      }
    }

    app.post('/api/gpt-chat', verifyFirebaseToken, async (req, res) => {
      const { messages, model = 'gpt-4-turbo', temperature = 0.7, max_tokens = 90 } = req.body;
      const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
      if (!OPENAI_API_KEY) return res.status(500).json({ error: 'API 키 없음' });

      try {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${OPENAI_API_KEY}`
          },
          body: JSON.stringify({ model, messages, temperature, max_tokens })
        });
        if (!response.ok) throw new Error(`OpenAI 오류: ${response.statusText}`);
        const gptData = await response.json();
        const raw = gptData?.choices?.[0]?.message?.content || '응답 없음';
        let json = {};
        try {
          const idx = raw.indexOf('{');
          if (idx !== -1) {
            json = JSON.parse(raw.substring(idx));
            res.json({ text: raw.substring(0, idx).trim(), analysis: json });
            return;
          }
        } catch (e) { /* ignore */ }
        res.json({ text: raw, analysis: {} });
      } catch (e) {
        console.error('[GPT 오류]', e);
        res.status(500).json({ error: '서버 오류', detail: e.message });
      }
    });

    // ✅ Google TTS API
    app.post('/api/google-tts', async (req, res) => {
      try {
        if (!ttsClient) return res.status(503).json({ error: 'TTS 기능이 비활성화됨' });

        const { text, voice = 'ko-KR-Chirp3-HD-Leda' } = req.body;
        if (!text) return res.status(400).json({ error: '텍스트 누락됨' });

        const request = {
          input: { text },
          voice: { languageCode: 'ko-KR', name: voice },
          audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: 24000 }
        };

        const [response] = await ttsClient.synthesizeSpeech(request);
        if (!response.audioContent) throw new Error('TTS 응답 없음');

        const audioBuffer = response.audioContent;
        res.set('Content-Type', 'audio/wav');
        res.send(audioBuffer);
      } catch (e) {
        console.error('❌ TTS 처리 오류 (gRPC):', e);
        res.status(500).json({ error: 'TTS 오류', detail: e.message });
      }
    });

    // ✅ Google STT API
    app.post('/api/stt', verifyFirebaseToken, async (req, res) => {
      try {
        if (!sttClient) return res.status(503).json({ error: 'STT 기능이 비활성화됨' });

        const audioBytes = req.body.toString('base64');
        const request = {
          audio: { content: audioBytes },
          config: { encoding: 'LINEAR16', sampleRateHertz: 24000, languageCode: 'ko-KR' }
        };

        const [response] = await sttClient.recognize(request);
        const transcript = response.results.map(r => r.alternatives[0].transcript).join('\n');
        res.json({ transcript });
      } catch (e) {
        console.error('❌ STT 오류:', e);
        res.status(500).json({ error: 'STT 실패', detail: e.message });
      }
    });

    // ⭐⭐ 데이터베이스 사용 예시 (API 라우트 내에서) ⭐⭐
    // 이 부분은 당신의 앱이 어떤 데이터를 DB에 저장하고 싶은지에 따라 달라집니다.
    // 예를 들어, 사용자 대화 기록을 저장하는 라우트를 추가할 수 있습니다.
    app.post('/api/save-chat-history', verifyFirebaseToken, async (req, res) => {
      if (!dbPool) {
        return res.status(500).json({ error: '데이터베이스에 연결되지 않았습니다.' });
      }
      const { userId, message, role, timestamp } = req.body; // 저장할 데이터 예시

      try {
        // 'chat_history' 테이블에 데이터 삽입 예시
        const [result] = await dbPool.query(
          'INSERT INTO chat_history (user_id, message, role, timestamp) VALUES (?, ?, ?, ?)',
          [userId, message, role, timestamp]
        );
        res.status(200).json({ message: '대화 기록 저장 성공', insertId: result.insertId });
      } catch (e) {
        console.error('❌ 대화 기록 저장 오류:', e);
        res.status(500).json({ error: '대화 기록 저장 실패', detail: e.message });
      }
    });

    // 서버 시작 시 DB 연결
    app.listen(port, async () => { // async 키워드 추가
      console.log(`🚀 서버 실행 중: http://localhost:${port}`);
      await connectToDatabase(); // 서버 시작 후 DB 연결 시도
    });
    

    // ✅ OpenAI GPT Vision 프록시 라우트
app.post('/api/gpt-vision', async (req, res) => {
  const { imageUrl, prompt } = req.body;

  if (!imageUrl || !prompt) {
    return res.status(400).json({ error: 'imageUrl과 prompt는 필수입니다.' });
  }

  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_API_KEY) return res.status(500).json({ error: 'API 키 없음' });

  try {
    const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4-vision-preview',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              {
                type: 'image_url',
                image_url: {
                  url: imageUrl,
                  detail: 'high'
                }
              }
            ]
          }
        ],
        max_tokens: 1000
      })
    });

    if (!openaiRes.ok) {
      const errorText = await openaiRes.text();
      console.error('🔴 GPT Vision 오류:', errorText);
      return res.status(500).json({ error: 'OpenAI Vision API 오류', detail: errorText });
    }

    const result = await openaiRes.json();
    const text = result?.choices?.[0]?.message?.content || '응답 없음';
    res.json({ text });
  } catch (error) {
    console.error('❌ Vision 프록시 서버 오류:', error);
    res.status(500).json({ error: '서버 내부 오류', detail: error.message });
  }
});

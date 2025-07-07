# Node.js 런타임 이미지 선택 (package.json의 engines.node 버전에 맞춤)
FROM node:20-slim

# 작업 디렉토리 설정
WORKDIR /app

# package.json 및 package-lock.json 복사 (의존성 캐싱을 위해 먼저 복사)
COPY package.json ./
# package-lock.json이 gitignore에 있지만, 존재한다면 복사하는 것이 좋습니다.
# 만약 package-lock.json이 필요하다면 .gitignore에서 해당 라인을 제거하고 Git에 커밋하세요.
# COPY package-lock.json ./

# 종속성 설치 (production 환경에 필요한 의존성만 설치)
RUN npm install --production

# 모든 소스 코드 복사
COPY . .

# 컨테이너가 리스닝할 포트 노출 (Cloud Run은 기본적으로 8080 포트를 사용)
EXPOSE 8080

# 애플리케이션 시작 명령
CMD ["node", "server.js"]
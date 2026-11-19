# CLI Usage Tracker (Windows 11)

Windows 11 작업 표시줄 알림 영역(시스템 트레이)에 상주하며 **GPT CLI (Codex)**, **AGY CLI (Antigravity)**, **Claude CLI (Claude Code)** 의 **5시간 · 주간 남은 사용량(잔여 %)** 과 리셋 시간을 한눈에 확인하는 경량 트레이 앱입니다.

## 주요 기능
- **초소형 Windows 11 트레이 플라이아웃 (`286px`):** 트레이 아이콘을 클릭하면 불필요한 여백 없이 로그인된 CLI의 남은 사용량 막대, 잔여 `%`, 리셋 카운트다운만 깔끔하게 표시합니다.
- **실시간 트레이 아이콘:** 3개 CLI의 남은 사용량을 다중 해상도 `.ico` 막대 아이콘으로 표시합니다. (미로그인 CLI는 빈 트랙으로 표시)
- **CLI별 개별 로그인 / 로그아웃:**
  - **GPT CLI (OpenAI Codex):** `codex login` 실행 / `%USERPROFILE%\.codex\auth.json` 자동 감지 및 파일 선택 / OAuth 토큰 직접 입력
  - **AGY CLI (Antigravity CLI):** `agy` 실행(미설치 시 공식 설치 스크립트 실행) / Windows 자격 증명 관리자(`gemini:antigravity`) 자동 감지 / 파일 선택 / 토큰 직접 입력
  - **Claude CLI (Claude Code):** `claude auth login` 실행 / `%USERPROFILE%\.claude\.credentials.json` · `%APPDATA%\claude\credentials.json` 자동 감지 / 파일 선택 / 토큰 직접 입력
- **보안 저장:** 직접 입력한 토큰은 Windows DPAPI(`safeStorage`)로 암호화되어 `%APPDATA%\cli-usage-tracker` 에만 로컬 저장됩니다.
- **알림센터 경고 & 자동 실행:** 잔여량이 임계치 이하로 내려가면 Windows 알림센터 토스트 알림을 띄우며, Windows 시작 시 자동 실행과 트레이 우클릭 **`앱 재시작`** 을 지원합니다.

## 설치 및 실행

```powershell
git clone <this-repo-url>
cd cli-usage-tracker
npm install
```

- **콘솔 창 없이 실행 (권장):** `start-tray.vbs` 더블클릭
- **터미널 실행:** `.\start-tray.bat` 또는 `npm start`

## 테스트

```powershell
npm test
```

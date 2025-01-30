# Eliza

<img src="./docs/static/img/eliza_banner.jpg" alt="eliza banner" width="100%"/>

## 기능

- 🛠 지지 discord 트위터/telegram 연결
- 👥 지지여 모드 agent
- 📚 간단 한 문서를 가져오기와 문서를 번갈아
- 💾 검색 할 수 있는 메모리와 문서 저장
- 🚀 확장 가능 성이 높은, 사용자 정의 클라이언트와 행위를 확장 기능
- ☁ ️여 모형 지지 llama · openai grok anthropic 등
- 📦 간단 하기도 좋습니다.

eliza로 뭘 할 수 있나요?

- 🤖 챗 봇
- 🕵 ️ 자주 agents
- 📈 업무 처리 과정을 자동화
- 🎮 게임 npc

# 사용시작

**전제 요구(필수):**

- [Node.js 22 +](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm)
- Nodejs 설치
- [pnpm](https://pnpm.io/installation)
- pnpm을사용한다

## 편집.env 파일

- .env.example을.env로 복사하고 적절한 값을 입력한다
- 트위터 환경을 편집하고, 트위터 계정과 비밀번호를 입력한다

## 캐릭터 파일 편집

- 파일 `packages/core/src/defaultCharacter.ts ` - 그것을 수정 할 수 있다
- 사용하셔도됩니다 `node --loader ts-node/esm src/index.ts --characters="path/to/your/character.json"` 여러 로봇을 동시에 실행하여 캐릭터를 불러옵니다.

아이디와 캐릭터 파일 설정이 완료되었다면, 다음 명령줄을 입력하여 로봇을 실행시키십시오:

```
pnpm i
pnpm start
```

# 사용자 정의 Eliza

### 일반 행동을 추가한다

커널 디렉터리에서 git 충돌을 방지하기 위해 custom_actions 디렉터리에 사용자 정의 동작을 추가하고 elizaconfig.yaml 파일에서 동작을 설정할 것을 제안한다.elizaconfig.example.yaml 파일의 예제는 참조할 수 있다.

다른 대형 모델들을 배치한다

### 프로필Llama

`XAI_MODEL`환경 변수를`meta-llama/meta-llam-3.1-70b-instruct-turbo`또는`meta-llama/meta-llam-3.1-405b-instruct`로 설정하여 실행할 수 있다라마 70b 405b 모델

## openai 설정

`XAI_MODEL`환경 변수를`gpt-4o-mini`또는`gpt-4o`로 설정하여 OpenAI 모델을 실행할 수 있다

## 기타 요구 사항

Sharp를 설치해야 할 수도 있습니다.시작시 오류가 발견되면 다음 명령으로 설치하십시오:

```
pnpm install-include=optional sharp
```

# 환경 설정

다양한 플랫폼에 연결하기 위해서는.env 파일에서 환경 변수를 추가해야 합니다:

```
# Required environment variables
DISCORD_APPLICATION_ID=
DISCORD_API_TOKEN= # Bot token
OPENAI_API_KEY=sk-* # OpenAI API key, starting with sk-
ELEVENLABS_XI_API_KEY= # API key from elevenlabs

# ELEVENLABS SETTINGS
ELEVENLABS_MODEL_ID=eleven_multilingual_v2
ELEVENLABS_VOICE_ID=21m00Tcm4TlvDq8ikWAM
ELEVENLABS_VOICE_STABILITY=0.5
ELEVENLABS_VOICE_SIMILARITY_BOOST=0.9
ELEVENLABS_VOICE_STYLE=0.66
ELEVENLABS_VOICE_USE_SPEAKER_BOOST=false
ELEVENLABS_OPTIMIZE_STREAMING_LATENCY=4
ELEVENLABS_OUTPUT_FORMAT=pcm_16000

TWITTER_DRY_RUN=false
TWITTER_USERNAME= # Account username
TWITTER_PASSWORD= # Account password
TWITTER_EMAIL= # Account email

X_SERVER_URL=
XAI_API_KEY=
XAI_MODEL=


# For asking Claude stuff
ANTHROPIC_API_KEY=

# EVM
EVM_PRIVATE_KEY=EXAMPLE_WALLET_PRIVATE_KEY

# Solana
SOLANA_PRIVATE_KEY=EXAMPLE_WALLET_PRIVATE_KEY
SOLANA_PUBLIC_KEY=EXAMPLE_WALLET_PUBLIC_KEY

# Fallback Wallet Configuration (deprecated)
WALLET_PRIVATE_KEY=EXAMPLE_WALLET_PRIVATE_KEY
WALLET_PUBLIC_KEY=EXAMPLE_WALLET_PUBLIC_KEY

BIRDEYE_API_KEY=

SOL_ADDRESS=So11111111111111111111111111111111111111112
SLIPPAGE=1
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
HELIUS_API_KEY=


## Telegram
TELEGRAM_BOT_TOKEN=

TOGETHER_API_KEY=
```

# 로컬 설정

### cuda 설정

고성능 엔비디아 그래픽을 가지고 있다면 다음 명령줄에서 cuda를 사용하여 로컬 가속을 할 수 있다

```
pnpm install
npx --no node-llama-cpp source download --gpu cuda
```

cuDNN과 cuBLAS를 포함한 완전한 cuda 키트를 설치했는지 확인하세요

### 로컬 실행

위의 [Llama로 실행](#run-with-llama) 옵션 중 하나로 XAI_MODEL을 추가한다
X_SERVER_URL과 xai_api_key를 공백으로 두면 huggingface에서 모델을 다운로드하고 현지에서 쿼리한다

# 클라이언트

discord bot을 설정하는 방법에 대해 discord의 공식 문서를 볼 수 있습니까

# 개발

## 테스트

여러 테스트 방법을 위한 명령줄:

```bash
pnpm test           # Run tests once
pnpm test:watch    # Run tests in watch mode
```

데이터베이스에 특화된 테스트:

```bash
pnpm test:sqlite   # Run tests with SQLite
pnpm test:sqljs    # Run tests with SQL.js
```

테스트는 src/\*_/_.test.ts 파일에 있는 Jest로 작성된다.테스트 환경 설정은 다음과 같습니다:

- .env.test에서 환경 변수를 불러온다
- 장기 실행 테스트를 실행하기 위해 2분 제한 시간을 사용합니다
- esm 모듈을 지원한다
- 테스트 실행 순서 (--runInBand)

새 테스트를 만들려면, 테스트할 코드 옆에.test.ts 파일을 추가하세요.

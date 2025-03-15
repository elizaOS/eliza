# Eliza

<img src="./docs/static/img/eliza_banner.jpg" alt="Eliza Banner" width="100%" />

## 機能

- 🛠 Discord、Twitter、Telegramのフル機能コネクタ
- 👥 マルチエージェントおよびルームサポート
- 📚 ドキュメントの簡単な取り込みと対話
- 💾 検索可能なメモリおよびドキュメントストア
- 🚀 高い拡張性 - 機能を拡張するための独自のアクションとクライアントを作成可能
- ☁️ Llama、OpenAI、Anthropic、Groqなど、多くのモデルをサポート
- 📦 すぐに使える！

## 何に使えるのか？

- 🤖 チャットボット
- 🕵️ 自律エージェント
- 📈 ビジネスプロセスの処理
- 🎮 ビデオゲームのNPC

# 始め方

**必須条件:**

- [Node.js 23+](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm)
- [pnpm](https://pnpm.io/installation)

### .envファイルの編集

- .env.exampleを.envにコピーし、適切な値を入力
- TWITTER環境変数を編集して、ボットのユーザー名とパスワードを追加

### キャラクターファイルの編集

- `packages/core/src/defaultCharacter.ts`ファイルを確認 - これを変更可能
- `pnpm start --characters="path/to/your/character.json"`を使用してキャラクターをロードし、複数のボットを同時に実行可能

.envファイルとキャラクターファイルを設定した後、以下のコマンドでボットを起動可能:

```
pnpm i
pnpm start
```

# Elizaのカスタマイズ

### カスタムアクションの追加

コアディレクトリでのGitの競合を避けるために、カスタムアクションを`custom_actions`ディレクトリに追加し、それを`elizaConfig.yaml`ファイルに追加することをお勧めします。例については`elizaConfig.example.yaml`ファイルを参照してください。

## 異なるモデルでの実行

### Llamaでの実行

`XAI_MODEL`環境変数を`meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo`または`meta-llama/Meta-Llama-3.1-405B-Instruct`に設定することで、Llama 70Bまたは405Bモデルを実行可能

### Grokでの実行

`XAI_MODEL`環境変数を`grok-beta`に設定することで、Grokモデルを実行可能

### OpenAIでの実行

`XAI_MODEL`環境変数を`gpt-4o-mini`または`gpt-4o`に設定することで、OpenAIモデルを実行可能

## 追加の要件

Sharpをインストールする必要があるかもしれません。起動時にエラーが表示された場合は、以下のコマンドでインストールを試みてください:

```
pnpm install --include=optional sharp
```

# 環境設定

さまざまなプラットフォームに接続するために、.envファイルに環境変数を追加する必要があります:

```
# 必須環境変数
DISCORD_APPLICATION_ID=
DISCORD_API_TOKEN= # ボットトークン
OPENAI_API_KEY=sk-* # OpenAI APIキー、sk-で始まる
ELEVENLABS_XI_API_KEY= # elevenlabsからのAPIキー

# ELEVENLABS設定
ELEVENLABS_MODEL_ID=eleven_multilingual_v2
ELEVENLABS_VOICE_ID=21m00Tcm4TlvDq8ikWAM
ELEVENLABS_VOICE_STABILITY=0.5
ELEVENLABS_VOICE_SIMILARITY_BOOST=0.9
ELEVENLABS_VOICE_STYLE=0.66
ELEVENLABS_VOICE_USE_SPEAKER_BOOST=false
ELEVENLABS_OPTIMIZE_STREAMING_LATENCY=4
ELEVENLABS_OUTPUT_FORMAT=pcm_16000

TWITTER_DRY_RUN=false
TWITTER_USERNAME= # アカウントのユーザー名
TWITTER_PASSWORD= # アカウントのパスワード
TWITTER_EMAIL= # アカウントのメール

XAI_API_KEY=
XAI_MODEL=


# Claudeに質問するため
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

# ローカル推論設定

### CUDA設定

NVIDIA GPUを持っている場合、CUDAをインストールしてローカル推論を大幅に高速化可能

```
pnpm install
npx --no node-llama-cpp source download --gpu cuda
```

CUDA Toolkit、cuDNN、cuBLASをインストールしていることを確認してください。

### ローカルでの実行

XAI_MODELを追加し、[Llamaでの実行](#run-with-llama)のオプションのいずれかに設定 - XAI_API_KEYを空白のままにしておくと、huggingfaceからモデルをダウンロードし、ローカルでクエリを実行します。

# クライアント

## Discordボット

Discordボットの設定に関するヘルプについては、こちらを参照してください: https://discordjs.guide/preparations/setting-up-a-bot-application.html

# 開発

## テスト

テストスイートを実行するには:

```bash
pnpm test           # テストを一度実行
pnpm test:watch    # ウォッチモードでテストを実行
```

データベース固有のテストの場合:

```bash
pnpm test:sqlite   # SQLiteでテストを実行
pnpm test:sqljs    # SQL.jsでテストを実行
```

テストはJestを使用して記述されており、`src/**/*.test.ts`ファイルにあります。テスト環境は次のように構成されています:

- `.env.test`から環境変数をロード
- 長時間実行されるテストのために2分のタイムアウトを使用
- ESMモジュールをサポート
- テストを順番に実行 (--runInBand)

新しいテストを作成するには、テストするコードの隣に`.test.ts`ファイルを追加します。

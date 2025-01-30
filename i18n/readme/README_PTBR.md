# Eliza

<img src="./docs/static/img/eliza_banner.jpg" alt="Eliza Banner" width="100%" />

## Funcionalidades

- 🛠 Conectores completos para Discord, Twitter e Telegram
- 👥 Suporte a múltiplos agentes e salas
- 📚 Ingestão e interação fácil com seus documentos
- 💾 Memória recuperável e armazenamento de documentos
- 🚀 Altamente extensível - crie suas próprias ações e clientes para estender as capacidades
- ☁️ Suporta muitos modelos, incluindo Llama local, OpenAI, Anthropic, Groq e mais
- 📦 Funciona perfeitamente!

## Para que posso usá-lo?

- 🤖 Chatbots
- 🕵️ Agentes autônomos
- 📈 Gestão de processos empresariais
- 🎮 NPCs em jogos de vídeo

# Começando

**Pré-requisitos (OBRIGATÓRIO):**

- [Python 2.7+](https://www.python.org/downloads/)
- [Node.js 23.3+](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm)
- [pnpm](https://pnpm.io/installation)

### Edite o arquivo .env

- Copie .env.example para .env e preencha os valores apropriados
- Edite as variáveis de ambiente do TWITTER para adicionar o nome de usuário e senha do seu bot

### Edite o arquivo de personagem

- Confira o arquivo `packages/core/src/defaultCharacter.ts` - você pode modificá-lo
- Você também pode carregar personagens com o comando `pnpm start --characters="path/to/your/character.json"` e executar múltiplos bots ao mesmo tempo.

Após configurar o arquivo .env e o arquivo de personagem, você pode iniciar o bot com o seguinte comando:

```
pnpm i
pnpm start
```

# Personalizando Eliza

### Adicionando ações personalizadas

Para evitar conflitos no diretório core, recomendamos adicionar ações personalizadas a um diretório `custom_actions` e depois adicioná-las ao arquivo `elizaConfig.yaml`. Veja o arquivo `elizaConfig.example.yaml` para um exemplo.

## Executando com diferentes modelos

### Executar com Llama

Você pode executar modelos Llama 70B ou 405B configurando a variável de ambiente `XAI_MODEL` para `meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo` ou `meta-llama/Meta-Llama-3.1-405B-Instruct`

### Executar com Grok

Você pode executar modelos Grok configurando a variável de ambiente `XAI_MODEL` para `grok-beta`

### Executar com OpenAI

Você pode executar modelos OpenAI configurando a variável de ambiente `XAI_MODEL` para `gpt-4o-mini` ou `gpt-4o`

## Requisitos Adicionais

Pode ser necessário instalar o Sharp. Se você encontrar um erro ao iniciar, tente instalá-lo com o seguinte comando:

```
pnpm install --include=optional sharp
```

# Configuração do Ambiente

Você precisará adicionar variáveis de ambiente ao seu arquivo .env para se conectar a várias plataformas:

```
# Variáveis de ambiente obrigatórias
DISCORD_APPLICATION_ID=
DISCORD_API_TOKEN= # Token do bot
OPENAI_API_KEY=sk-* # Chave API do OpenAI, começando com sk-
ELEVENLABS_XI_API_KEY= # Chave API do elevenlabs
GOOGLE_GENERATIVE_AI_API_KEY= # Chave API do Gemini

# CONFIGURAÇÕES DO ELEVENLABS
ELEVENLABS_MODEL_ID=eleven_multilingual_v2
ELEVENLABS_VOICE_ID=21m00Tcm4TlvDq8ikWAM
ELEVENLABS_VOICE_STABILITY=0.5
ELEVENLABS_VOICE_SIMILARITY_BOOST=0.9
ELEVENLABS_VOICE_STYLE=0.66
ELEVENLABS_VOICE_USE_SPEAKER_BOOST=false
ELEVENLABS_OPTIMIZE_STREAMING_LATENCY=4
ELEVENLABS_OUTPUT_FORMAT=pcm_16000

TWITTER_DRY_RUN=false
TWITTER_USERNAME= # Nome de usuário da conta
TWITTER_PASSWORD= # Senha da conta
TWITTER_EMAIL= # Email da conta

XAI_API_KEY=
XAI_MODEL=


# Para perguntar coisas ao Claude
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

# Configuração de Inferência Local

### Configuração CUDA

Se você tiver uma GPU NVIDIA, pode instalar o CUDA para acelerar dramaticamente a inferência local.

```
pnpm install
npx --no node-llama-cpp source download --gpu cuda
```

Certifique-se de ter instalado o CUDA Toolkit, incluindo cuDNN e cuBLAS.

### Executando localmente

Adicione XAI_MODEL e configure-o para uma das opções acima de [Executar com Llama](#executar-com-llama) - você pode deixar XAI_API_KEY em branco, ele baixa o modelo do huggingface e faz consultas localmente

# Clientes

## Bot do Discord

Para ajuda com a configuração do seu Bot do Discord, confira aqui: https://discordjs.guide/preparations/setting-up-a-bot-application.html

# Desenvolvimento

## Testes

Para executar a suíte de testes:

```bash
pnpm test           # Executar testes uma vez
pnpm test:watch    # Executar testes no modo watch
```

Para testes específicos de banco de dados:

```bash
pnpm test:sqlite   # Executar testes com SQLite
pnpm test:sqljs    # Executar testes com SQL.js
```

Os testes são escritos usando Jest e podem ser encontrados em arquivos `src/**/*.test.ts`. O ambiente de teste está configurado para:

- Carregar variáveis de ambiente de `.env.test`
- Usar um tempo limite de 2 minutos para testes de longa duração
- Suportar módulos ESM
- Executar testes em sequência (--runInBand)

Para criar novos testes, adicione um arquivo `.test.ts` adjacente ao código que você está testando.

# Eliza - framework de simulação Multi-agentes

# https://github.com/elizaOS/eliza

# Visite https://eliza.builders para suporte

## 🌍 README Traduções

[中文说明](README_CN.md) | [Deutsch](README_DE.md) | [Français](README_FR.md) | [ไทย](README_TH.md) | [Español](README_ES.md) | [Português](README_PT.md)

# dev branch

<img src="static/img/eliza_banner.jpg" alt="Eliza Banner" width="100%" />

_Como visto dando funcionamento em [@DegenSpartanAI](https://x.com/degenspartanai) e [@MarcAIndreessen](https://x.com/pmairca)_

- Framework Multi-agente de simulação
- Adicione quantos personagens únicos quiser com o [characterfile](https://github.com/lalalune/characterfile/)
- Conectores completos para Discord e Twitter, com suporte para canais de voz no Discord
- Memória RAG completa para conversas e documentos
- Pode ler links e PDFs, transcrever áudios e vídeos, resumir conversas e muito mais
- Altamente extensível - crie suas próprias ações e clientes para ampliar as capacidades do Eliza
- Suporte para modelos de código aberto e locais (configuração padrão com Nous Hermes Llama 3.1B)
- Suporte ao OpenAI para inferência em nuvem em dispositivos com configurações leves
- Modo "Perguntar ao Claude" para chamadas a Claude em consultas mais complexas
- 100% Typescript

# Iniciando

**Pré-requisitos (OBRIGATÓRIO):**

- [Node.js 23+](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm)
- [pnpm](https://pnpm.io/installation)

### Edite o arquivo .env

- Copie .env.example para .env e preencha com valores apropriados
- Edite as variáveis de ambiente do TWITTER para adicionar o nome de usuário e a senha do seu bot

### Edite o arquivo de personagem (character file)

- Verifique o arquivo `packages/core/src/defaultCharacter.ts` - você pode modificá-lo
- Você também pode carregar personagens com o comando  `pnpm start --characters="path/to/your/character.json"` e executar vários bots ao mesmo tempo.

Após configurar o arquivo .env e o arquivo de personagem (character file), você pode iniciar o bot com o seguinte comando:

```
pnpm i
pnpm start
```

# Personalizando Eliza

### Adicionando ações personalizadas

Para evitar conflitos no diretório principal, recomendamos adicionar ações personalizadas a um diretório chamado  `custom_actions` e, em seguida, incluí-las no arquivo `elizaConfig.yaml`. Consulte o arquivo `elizaConfig.example.yaml` para um exemplo.

## Rodando com diferentes modelos

### Rode com Llama

Você pode executar modelos Llama 70B ou 405B configurando a variável de ambiente `XAI_MODEL` para `meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo` ou `meta-llama/Meta-Llama-3.1-405B-Instruct`

### Rode com Grok

Você pode executar modelos Grok configurando a variável de ambiente `XAI_MODEL` para `grok-beta`.

### Rode com OpenAI

Você pode executar modelos OpenAI configurando a variável de ambiente para `gpt-4-mini` or `gpt-4o`

## Requisitos Adicionais

Você pode precisar instalar o Sharp. Se aparecer um erro ao iniciar, tente instalá-lo com o seguinte comando:

```
pnpm install --include=optional sharp
```

# Configuração do Ambiente

Você precisará adicionar variáveis de ambiente ao seu arquivo .env para conectar a diversas plataformas:

```
# Variaveis de ambiente obrigatorias
DISCORD_APPLICATION_ID=
DISCORD_API_TOKEN= # Bot token
OPENAI_API_KEY=sk-* # OpenAI API key, começando com sk-
ELEVENLABS_XI_API_KEY= # API key da elevenlabs

# Configuracoes ELEVENLABS
ELEVENLABS_MODEL_ID=eleven_multilingual_v2
ELEVENLABS_VOICE_ID=21m00Tcm4TlvDq8ikWAM
ELEVENLABS_VOICE_STABILITY=0.5
ELEVENLABS_VOICE_SIMILARITY_BOOST=0.9
ELEVENLABS_VOICE_STYLE=0.66
ELEVENLABS_VOICE_USE_SPEAKER_BOOST=false
ELEVENLABS_OPTIMIZE_STREAMING_LATENCY=4
ELEVENLABS_OUTPUT_FORMAT=pcm_16000

TWITTER_DRY_RUN=false
TWITTER_USERNAME= # Usuário da conta
TWITTER_PASSWORD= # Senha da conta
TWITTER_EMAIL= # Email da conta

X_SERVER_URL=
XAI_API_KEY=
XAI_MODEL=


# Para perguntas ao Claude
ANTHROPIC_API_KEY=

WALLET_SECRET_KEY=EXAMPLE_WALLET_SECRET_KEY
WALLET_PUBLIC_KEY=EXAMPLE_WALLET_PUBLIC_KEY

BIRDEYE_API_KEY=

SOL_ADDRESS=So11111111111111111111111111111111111111112
SLIPPAGE=1
RPC_URL=https://api.mainnet-beta.solana.com
HELIUS_API_KEY=


## Telegram
TELEGRAM_BOT_TOKEN=

TOGETHER_API_KEY=
```

# Configuração de Inferência Local

### Configuração CUDA

Se você tiver uma GPU NVIDIA, pode instalar o CUDA para acelerar significativamente a inferência local.

```
pnpm install
npx --no node-llama-cpp source download --gpu cuda
```

Certifique-se de que você instalou o CUDA Toolkit, incluindo o cuDNN e cuBLAS.

### Rodando localmente

Add XAI_MODEL e defina-o para uma das opções mencionadas em [Run with
Llama](#run-with-llama) - você pode deixar X_SERVER_URL e XAI_API_KEY em branco,
pois o modelo será baixado do Hugging Face e consultado localmente.

# Clientes

## Discord Bot

Para ajuda com a configuração do seu bot no Discord, consulte aqui: https://discordjs.guide/preparations/setting-up-a-bot-application.html

# Desenvolvimento

## Testando

Para executar a suíte de testes:

```bash
pnpm test           # Executar os testes uma vez
pnpm test:watch    # Executar os testes no modo de observação/monitoramento (watch mode)
```

Para testes específicos de banco de dados:

```bash
pnpm test:sqlite   # Rode testes com SQLite
pnpm test:sqljs    # Rode testes com SQL.js
```

Os testes são escritos usando o Jest e podem ser encontrados nos arquivos. O ambiente de teste está configurado para:

- Carregar variáveis de ambiente do arquivo `.env.test`
- Usar um tempo limite de 2 minutos para testes de longa duração
- Suportar módulos ESM
- Executar os testes em sequência (--runInBand)

Para criar novos testes, adicione um arquivo `.test.ts` ao lado do código que você está testando.

## Atualizações da Documentação

Por favor, verifique se a documentação fornecida está correta. Para fazer isso, execute o serviço de documentação (docs) abaixo.

```console
docker compose -f docker-compose-docs.yaml up --build
```

O servidor do Docusaurus será iniciado e você poderá verificar a documentação localmente em https://localhost:3000/eliza.

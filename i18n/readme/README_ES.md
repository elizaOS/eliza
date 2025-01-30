# Eliza

<img src="./docs/static/img/eliza_banner.jpg" alt="Banner de Eliza" width="100%" />

## Funcionalidades

- 🛠 Conectores completos para Discord, Twitter y Telegram
- 👥 Soporte para múltiples agentes y salas
- 📚 Ingestión e interacción sencilla con documentos
- 💾 Memoria recuperable y almacenamiento de documentos
- 🚀 Altamente extensible - cree sus propias acciones y clientes para expandir capacidades
- ☁️ Soporta múltiples modelos, incluidos Llama local, OpenAI, Anthropic, Groq y más
- 📦 Funciona perfectamente

## Usos

- 🤖 Chatbots
- 🕵️ Agentes autónomos
- 📈 Gestión de procesos empresariales
- 🎮 NPCs en videojuegos

# Primeros Pasos

**Requisitos (OBLIGATORIOS):**

- [Python 2.7+](https://www.python.org/downloads/)
- [Node.js 23.3+](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm)
- [pnpm](https://pnpm.io/installation)

### Edite el archivo .env

- Copie el archivo .env.example a .env y complete los valores apropiados
- Edite las variables de entorno de TWITTER para agregar nombre de usuario y contraseña del bot

### Edite el archivo de personaje

- Revise el archivo `packages/core/src/defaultCharacter.ts` - puede modificarlo
- También puede cargar personajes con el comando `pnpm start --characters="path/to/your/character.json"` y ejecutar múltiples bots simultáneamente.

Después de configurar el archivo .env y el archivo de personaje, puede iniciar el bot con:

```
pnpm i
pnpm start
```

# Personalizando a Eliza

### Agregando acciones personalizadas

Para evitar conflictos en el directorio central, se recomienda agregar acciones personalizadas a un directorio `custom_actions` y luego agregarlas al archivo `elizaConfig.yaml`. Consulte el archivo `elizaConfig.example.yaml` para un ejemplo.

## Ejecución con Diferentes Modelos

### Ejecutar con Llama

Puede ejecutar modelos Llama 70B o 405B configurando la variable de ambiente para un proveedor que soporte estos modelos. Llama también es soportado localmente si no se configura otro proveedor.

### Ejecutar con Grok

Puede ejecutar modelos Grok configurando la variable de ambiente `GROK_API_KEY` y configurando "grok" como proveedor en el archivo de caracteres.

### Ejecutar con OpenAI

Puede ejecutar modelos OpenAI configurando la variable de ambiente `OPENAI_API_KEY` y configurando "openai" como proveedor en el archivo de caracteres.

## Requisitos Adicionales

Puede ser necesario instalar Sharp. Si encuentra un error al iniciar, intente instalarlo con:

```
pnpm install --include=optional sharp
```

# Configuración del Entorno

Deberá agregar variables de ambiente a su archivo .env para conectarse a varias plataformas:

```
# Variables de ambiente obligatorias
DISCORD_APPLICATION_ID=
DISCORD_API_TOKEN= # Token del bot
OPENAI_API_KEY=sk-* # Clave API de OpenAI, comenzando con sk-
ELEVENLABS_XI_API_KEY= # Clave API de ElevenLabs
GOOGLE_GENERATIVE_AI_API_KEY= # Clave API de Gemini

# CONFIGURACIONES DE ELEVENLABS
ELEVENLABS_MODEL_ID=eleven_multilingual_v2
ELEVENLABS_VOICE_ID=21m00Tcm4TlvDq8ikWAM
ELEVENLABS_VOICE_STABILITY=0.5
ELEVENLABS_VOICE_SIMILARITY_BOOST=0.9
ELEVENLABS_VOICE_STYLE=0.66
ELEVENLABS_VOICE_USE_SPEAKER_BOOST=false
ELEVENLABS_OPTIMIZE_STREAMING_LATENCY=4
ELEVENLABS_OUTPUT_FORMAT=pcm_16000

TWITTER_DRY_RUN=false
TWITTER_USERNAME= # Nombre de usuario de la cuenta
TWITTER_PASSWORD= # Contraseña de la cuenta
TWITTER_EMAIL= # Correo electrónico de la cuenta

# Para consultar a Claude
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

# Configuración de Inferencia Local

### Configuración CUDA

Si tiene una GPU NVIDIA, puede instalar CUDA para acelerar significativamente la inferencia local.

```
pnpm install
npx --no node-llama-cpp source download --gpu cuda
```

Asegúrese de tener instalado el CUDA Toolkit, incluyendo cuDNN y cuBLAS.

### Ejecución local

Agregue XAI_MODEL y configúrelo con una de las opciones de [Ejecutar con Llama](#ejecutar-con-llama) - puede dejar XAI_API_KEY en blanco, descargará el modelo de HuggingFace y realizará consultas localmente

# Clientes

## Bot de Discord

Para ayuda con la configuración de su Bot de Discord, consulte: https://discordjs.guide/preparations/setting-up-a-bot-application.html

# Desarrollo

## Pruebas

Para ejecutar la suite de pruebas:

```bash
pnpm test           # Ejecutar pruebas una vez
pnpm test:watch    # Ejecutar pruebas en modo observación
```

Para pruebas específicas de base de datos:

```bash
pnpm test:sqlite   # Ejecutar pruebas con SQLite
pnpm test:sqljs    # Ejecutar pruebas con SQL.js
```

Las pruebas están escritas con Jest y se pueden encontrar en archivos `src/**/*.test.ts`. El entorno de pruebas está configurado para:

- Cargar variables de ambiente desde `.env.test`
- Usar un límite de 2 minutos para pruebas de larga duración
- Soportar módulos ESM
- Ejecutar pruebas en secuencia (--runInBand)

Para crear nuevas pruebas, agregue un archivo `.test.ts` junto al código que está probando.

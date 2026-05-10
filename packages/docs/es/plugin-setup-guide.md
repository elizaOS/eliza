---
title: Guía de Configuración de Plugins
description: Instrucciones completas de configuración para los plugins de conectores, proveedores de IA y transmisión de Eliza.
---

<div id="plugin-setup-guide--eliza-ai">

# Guía de Configuración de Plugins — Eliza AI
</div>

Instrucciones completas de configuración para todos los plugins de conectores, proveedores de IA y transmisión.
Cuando los usuarios pregunten cómo configurar un plugin, usa esta guía: proporciónales los nombres exactos de las variables de entorno,
dónde obtener las credenciales, los campos mínimos requeridos y consejos para los campos opcionales.

---

<div id="ai-providers">

## Proveedores de IA
</div>

<div id="openai">

### OpenAI
</div>

**Obtener credenciales:** https://platform.openai.com/api-keys
**Mínimo requerido:** `OPENAI_API_KEY` (comienza con `sk-`)
**Variables:**
- `OPENAI_API_KEY` — Tu clave secreta de API de platform.openai.com
- `OPENAI_BASE_URL` — Deja en blanco para el valor predeterminado de OpenAI; configura una URL de proxy si usas un endpoint personalizado
- `OPENAI_SMALL_MODEL` — p. ej. `gpt-5-mini` (usado para tareas rápidas/económicas)
- `OPENAI_LARGE_MODEL` — p. ej. `gpt-4o` (usado para razonamiento complejo)
- `OPENAI_EMBEDDING_MODEL` — p. ej. `text-embedding-3-small` (para búsqueda semántica)
- `OPENAI_TTS_MODEL` / `OPENAI_TTS_VOICE` — p. ej. `tts-1` / `alloy` (para síntesis de voz)
- `OPENAI_IMAGE_DESCRIPTION_MODEL` — p. ej. `gpt-4o` (para comprensión de imágenes)
**Consejos:** OpenAI es el respaldo predeterminado para la mayoría de las funciones. Si tienes créditos, configura este primero. Usa `gpt-5-mini` como modelo pequeño para ahorrar costos.

<div id="anthropic">

### Anthropic
</div>

**Obtener credenciales:** https://console.anthropic.com/settings/keys
**Mínimo requerido:** `ANTHROPIC_API_KEY` (comienza con `sk-ant-`) o `CLAUDE_API_KEY`
**Variables:**
- `ANTHROPIC_API_KEY` / `CLAUDE_API_KEY` — Tu clave secreta de console.anthropic.com (cualquiera funciona para auto-habilitación)
- `ANTHROPIC_SMALL_MODEL` — p. ej. `claude-haiku-4-5-20251001`
- `ANTHROPIC_LARGE_MODEL` — p. ej. `claude-sonnet-4-6`
- `ANTHROPIC_BROWSER_BASE_URL` — (Avanzado) URL de proxy para solicitudes del lado del navegador
**Consejos:** Ideal para razonamiento complejo y contexto largo. Claude Haiku es muy rápido para el slot de modelo pequeño.

<div id="google-gemini">

### Google Gemini
</div>

**Obtener credenciales:** https://aistudio.google.com/app/apikey
**Mínimo requerido:** `GOOGLE_GENERATIVE_AI_API_KEY` o `GOOGLE_API_KEY`
**Variables:**
- `GOOGLE_GENERATIVE_AI_API_KEY` / `GOOGLE_API_KEY` — De AI Studio o Google Cloud (cualquiera funciona para auto-habilitación)
- `GOOGLE_SMALL_MODEL` — p. ej. `gemini-2.0-flash`
- `GOOGLE_LARGE_MODEL` — p. ej. `gemini-2.0-pro`
- `GOOGLE_EMBEDDING_MODEL` — p. ej. `text-embedding-004`
- `GOOGLE_IMAGE_MODEL` — p. ej. `imagen-3.0-generate-002`
**Consejos:** Gemini Flash es rápido y económico; excelente como modelo pequeño. El nivel gratuito es generoso.

<div id="groq">

### Groq
</div>

**Obtener credenciales:** https://console.groq.com/keys
**Mínimo requerido:** `GROQ_API_KEY`
**Variables:**
- `GROQ_API_KEY` — De console.groq.com
- `GROQ_SMALL_MODEL` — p. ej. `openai/gpt-oss-120b`
- `GROQ_LARGE_MODEL` — p. ej. `openai/gpt-oss-120b`
- `GROQ_TTS_MODEL` / `GROQ_TTS_VOICE` — p. ej. `playai-tts` / `Fritz-PlayAI`
**Consejos:** Groq ofrece inferencia extremadamente rápida — ideal para casos de uso sensibles a la latencia. Nivel gratuito disponible. Soporta TTS a través de voces PlayAI.

<div id="openrouter">

### OpenRouter
</div>

**Obtener credenciales:** https://openrouter.ai/keys
**Mínimo requerido:** `OPENROUTER_API_KEY`
**Variables:**
- `OPENROUTER_API_KEY` — De openrouter.ai/keys
- `OPENROUTER_SMALL_MODEL` — p. ej. `openai/gpt-5-mini` o `openai/gpt-oss-120b`
- `OPENROUTER_LARGE_MODEL` — p. ej. `anthropic/claude-sonnet-4-6`
- `OPENROUTER_IMAGE_MODEL` — p. ej. `openai/gpt-4o` (para tareas de visión)
- `OPENROUTER_IMAGE_GENERATION_MODEL` — p. ej. `openai/dall-e-3`
- `OPENROUTER_EMBEDDING_MODEL` — p. ej. `openai/text-embedding-3-small`
- `OPENROUTER_TOOL_EXECUTION_MAX_STEPS` — Máximo de pasos de llamadas a herramientas por turno (predeterminado: 5)
**Consejos:** OpenRouter te da acceso a más de 200 modelos a través de una sola clave de API. Ideal si quieres cambiar de modelo sin gestionar múltiples cuentas. Usa los IDs de modelo en formato `provider/model-name`.

<div id="xai-grok">

### xAI (Grok)
</div>

**Obtener credenciales:** https://console.x.ai/
**Mínimo requerido:** `XAI_API_KEY` o `GROK_API_KEY`
**Variables:**
- `XAI_API_KEY` / `GROK_API_KEY` — De console.x.ai (cualquiera funciona para auto-habilitación)
- `XAI_MODEL` — p. ej. `grok-2-1212` (anula pequeño/grande)
- `XAI_SMALL_MODEL` / `XAI_LARGE_MODEL` — Slots de modelo específicos
- `XAI_EMBEDDING_MODEL` — p. ej. `v1`
- `X_AUTH_MODE` — `api_key` (predeterminado) o `oauth`
- `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET` — Claves OAuth de Twitter (para el lado del conector X de xAI)
- `X_ENABLE_POST`, `X_ENABLE_REPLIES`, `X_ENABLE_ACTIONS` — Alternar comportamientos de X/Twitter
**Consejos:** xAI = modelos Grok. Las variables `X_*` son para la integración de Twitter incluida con xAI. Mantén el modo de autenticación como `api_key` a menos que necesites OAuth.

<div id="ollama-local-models">

### Ollama (Modelos Locales)
</div>

**Obtener credenciales:** No se necesita clave de API — instala Ollama localmente
**Configuración:** https://ollama.com — ejecuta `ollama pull llama3.2` para descargar un modelo
**Mínimo requerido:** `OLLAMA_BASE_URL` = `http://localhost:11434` (disparador de auto-habilitación) o `OLLAMA_API_ENDPOINT` = `http://localhost:11434/api`
**Variables:**
- `OLLAMA_BASE_URL` — Disparador de auto-habilitación. Predeterminado: `http://localhost:11434`
- `OLLAMA_API_ENDPOINT` — Endpoint del plugin. Predeterminado: `http://localhost:11434/api`
- `OLLAMA_SMALL_MODEL` — p. ej. `llama3.2:3b`
- `OLLAMA_MEDIUM_MODEL` — p. ej. `llama3.2`
- `OLLAMA_LARGE_MODEL` — p. ej. `llama3.2`
- `OLLAMA_EMBEDDING_MODEL` — p. ej. `nomic-embed-text`
**Consejos:** Completamente gratuito y privado. Requiere Ollama ejecutándose en tu máquina o un servidor. Descarga modelos con `ollama pull <model>`. Para embeddings usa `nomic-embed-text`.

<div id="local-ai">

### Local AI
</div>

**Obtener credenciales:** Sin clave de API — usa archivos de modelo locales
**Variables:**
- `MODELS_DIR` — Ruta a tus archivos de modelo locales (p. ej. `/Users/you/models`)
- `CACHE_DIR` — Ruta para caché (p. ej. `/tmp/ai-cache`)
- `LOCAL_SMALL_MODEL` / `LOCAL_LARGE_MODEL` — Nombres de archivo de modelos en MODELS_DIR
- `LOCAL_EMBEDDING_MODEL` / `LOCAL_EMBEDDING_DIMENSIONS` — Modelo de embedding y su número de dimensiones
- `CUDA_VISIBLE_DEVICES` — Selección de GPU, p. ej. `0` para la primera GPU
**Consejos:** Úsalo cuando tengas archivos de modelo .gguf o similares y quieras operación completamente offline.

<div id="vercel-ai-gateway">

### Vercel AI Gateway
</div>

**Obtener credenciales:** https://vercel.com/docs/ai/ai-gateway
**Mínimo requerido:** `AI_GATEWAY_API_KEY` y `AI_GATEWAY_BASE_URL`
**Variables:**
- `AI_GATEWAY_API_KEY` / `AIGATEWAY_API_KEY` — Tu clave de gateway (cualquiera funciona)
- `VERCEL_OIDC_TOKEN` — Solo para despliegues alojados en Vercel
- `AI_GATEWAY_BASE_URL` — La URL de tu endpoint de gateway
- `AI_GATEWAY_SMALL_MODEL` / `AI_GATEWAY_LARGE_MODEL` / `AI_GATEWAY_EMBEDDING_MODEL` — IDs de modelo
- `AI_GATEWAY_IMAGE_MODEL` — Para generación de imágenes
- `AI_GATEWAY_TIMEOUT_MS` — Tiempo de espera de solicitud, predeterminado 30000ms
**Consejos:** Enruta las llamadas a modelos a través del AI gateway de Vercel para caché, limitación de tasa y observabilidad. Útil si ya estás en Vercel.

<div id="deepseek">

### DeepSeek
</div>

**Obtener credenciales:** https://platform.deepseek.com/api_keys
**Mínimo requerido:** `DEEPSEEK_API_KEY`
**Variables:**
- `DEEPSEEK_API_KEY` — Tu clave de API de platform.deepseek.com
- `DEEPSEEK_SMALL_MODEL` — p. ej. `deepseek-chat`
- `DEEPSEEK_LARGE_MODEL` — p. ej. `deepseek-reasoner`
**Consejos:** DeepSeek ofrece precios competitivos y modelos de razonamiento potentes. El modelo `deepseek-reasoner` soporta razonamiento con cadena de pensamiento.

<div id="together-ai">

### Together AI
</div>

**Obtener credenciales:** https://api.together.xyz/settings/api-keys
**Mínimo requerido:** `TOGETHER_API_KEY`
**Variables:**
- `TOGETHER_API_KEY` — De api.together.xyz
- `TOGETHER_SMALL_MODEL` — p. ej. `meta-llama/Llama-3.2-3B-Instruct-Turbo`
- `TOGETHER_LARGE_MODEL` — p. ej. `deepseek-ai/DeepSeek-V3`
- `TOGETHER_EMBEDDING_MODEL` — p. ej. `togethercomputer/m2-bert-80M-8k-retrieval`
- `TOGETHER_IMAGE_MODEL` — p. ej. `black-forest-labs/FLUX.1-schnell`
**Consejos:** Together AI aloja una amplia gama de modelos de código abierto. Ideal para acceder a Llama, Mixtral y otros modelos abiertos a través de API.

<div id="mistral">

### Mistral
</div>

**Obtener credenciales:** https://console.mistral.ai/api-keys
**Mínimo requerido:** `MISTRAL_API_KEY`
**Variables:**
- `MISTRAL_API_KEY` — De console.mistral.ai
- `MISTRAL_SMALL_MODEL` — p. ej. `mistral-small-latest`
- `MISTRAL_LARGE_MODEL` — p. ej. `mistral-large-latest`
- `MISTRAL_EMBEDDING_MODEL` — p. ej. `mistral-embed`
**Consejos:** Los modelos de Mistral son rápidos y rentables. Buenos para requisitos de residencia de datos europeos.

<div id="cohere">

### Cohere
</div>

**Obtener credenciales:** https://dashboard.cohere.com/api-keys
**Mínimo requerido:** `COHERE_API_KEY`
**Variables:**
- `COHERE_API_KEY` — De dashboard.cohere.com
- `COHERE_SMALL_MODEL` — p. ej. `command-r`
- `COHERE_LARGE_MODEL` — p. ej. `command-r-plus`
- `COHERE_EMBEDDING_MODEL` — p. ej. `embed-english-v3.0`
**Consejos:** Cohere destaca en RAG (generación aumentada por recuperación) y tareas multilingües. Sus modelos de embedding son de nivel producción.

<div id="perplexity">

### Perplexity
</div>

**Obtener credenciales:** https://www.perplexity.ai/settings/api
**Mínimo requerido:** `PERPLEXITY_API_KEY`
**Variables:**
- `PERPLEXITY_API_KEY` — De la configuración de perplexity.ai
- `PERPLEXITY_SMALL_MODEL` — p. ej. `llama-3.1-sonar-small-128k-online`
- `PERPLEXITY_LARGE_MODEL` — p. ej. `llama-3.1-sonar-large-128k-online`
**Consejos:** Los modelos de Perplexity tienen búsqueda web integrada — ideales para tareas que requieren información actualizada.

<div id="google-antigravity">

### Google Antigravity
</div>

**Obtener credenciales:** Clave de API de Google Cloud con acceso a Antigravity
**Mínimo requerido:** `GOOGLE_CLOUD_API_KEY`
**Variables:**
- `GOOGLE_CLOUD_API_KEY` — Clave de API de Google Cloud
**Consejos:** Google Antigravity es un proveedor de modelos especializado de Google. Requiere credenciales de Google Cloud separadas de Google Gemini.

<div id="qwen">

### Qwen
</div>

**Mínimo requerido:** Configurar a través de la configuración de plugins de proveedores en `eliza.json`
**Variables:**
- Configura los IDs de modelo a través del bloque de configuración `providers.qwen` en `eliza.json`
**Consejos:** Modelos Qwen de Alibaba Cloud. Configura a través de la sección de proveedores de tu configuración.

<div id="minimax">

### Minimax
</div>

**Mínimo requerido:** Configurar a través de la configuración de plugins de proveedores en `eliza.json`
**Variables:**
- Configura los IDs de modelo a través del bloque de configuración `providers.minimax` en `eliza.json`
**Consejos:** Minimax proporciona modelos de IA chinos y multilingües.

<div id="zai">

### Zai
</div>

**Obtener credenciales:** De Homunculus Labs
**Mínimo requerido:** `ZAI_API_KEY`
**Variables:**
- `ZAI_API_KEY` — Tu clave de API de Zai de Homunculus Labs
**Consejos:** Zai es un proveedor de modelos de Homunculus Labs. Paquete del plugin: `@homunculuslabs/plugin-zai`.

<div id="eliza-cloud">

### Eliza Cloud
</div>

**Obtener credenciales:** Del servicio elizaOS Cloud
**Mínimo requerido:** `ELIZAOS_CLOUD_API_KEY` o `ELIZAOS_CLOUD_ENABLED=true`
**Variables:**
- `ELIZAOS_CLOUD_API_KEY` — Tu clave de API de Eliza Cloud
- `ELIZAOS_CLOUD_ENABLED` — Establece en `true` para habilitar las funciones en la nube
**Consejos:** Eliza Cloud proporciona infraestructura alojada para ejecutar agentes de Eliza con escalado y monitoreo gestionados.

---

<div id="connectors">

## Conectores
</div>

<div id="discord">

### Discord
</div>

**Obtener credenciales:** https://discord.com/developers/applications → Nueva Aplicación → Bot → Restablecer Token
**Mínimo requerido:** `DISCORD_API_TOKEN` + `DISCORD_APPLICATION_ID`
**Variables:**
- `DISCORD_API_TOKEN` — Token del bot (de la sección Bot, haz clic en Restablecer Token)
- `DISCORD_APPLICATION_ID` — ID de la aplicación (de Información General)
- `CHANNEL_IDS` — IDs de canales separados por comas para escuchar
- `DISCORD_VOICE_CHANNEL_ID` — Para soporte de canales de voz
- `DISCORD_SHOULD_IGNORE_BOT_MESSAGES` — `true` para prevenir bucles entre bots
- `DISCORD_SHOULD_IGNORE_DIRECT_MESSAGES` — `true` para deshabilitar respuestas por DM
- `DISCORD_SHOULD_RESPOND_ONLY_TO_MENTIONS` — `true` para solo responder cuando se le @menciona
- `DISCORD_LISTEN_CHANNEL_IDS` — IDs de canales para escuchar pero no publicar sin solicitud
**Pasos de configuración:**
1. Crea una app en discord.com/developers/applications
2. Ve a la pestaña Bot → Restablecer Token (copia inmediatamente)
3. Obtén el ID de la Aplicación de la pestaña Información General
4. En OAuth2 → Generador de URL → Bot → selecciona permisos: Enviar Mensajes, Leer Mensajes, Usar Comandos Slash
5. Invita al bot usando la URL generada
6. Habilita Message Content Intent en Bot → Privileged Gateway Intents
**Consejos:** Necesitas TANTO el Token del Bot COMO el ID de la Aplicación — sin el ID de la Aplicación los comandos slash no se registrarán. Haz clic derecho en un canal y Copiar ID para obtener los IDs de canal (habilita el Modo Desarrollador en la configuración de Discord primero).

<div id="telegram">

### Telegram
</div>

**Obtener credenciales:** Envía un mensaje a @BotFather en Telegram
**Mínimo requerido:** `TELEGRAM_BOT_TOKEN`
**Variables:**
- `TELEGRAM_BOT_TOKEN` — De @BotFather después de `/newbot`
- `TELEGRAM_ALLOWED_CHATS` — Array JSON de IDs de chat permitidos, p. ej. `["123456789", "-100987654321"]`
- `TELEGRAM_API_ROOT` — Deja en blanco para el predeterminado; configura si usas un proxy de Telegram
- `TELEGRAM_TEST_CHAT_ID` — Para pruebas (avanzado)
**Pasos de configuración:**
1. Envía mensaje a @BotFather: `/newbot`
2. Dale un nombre y un nombre de usuario
3. Copia el token que te proporciona
4. Para obtener tu ID de chat: envía un mensaje a @userinfobot
**Consejos:** Usa IDs negativos para grupos (comienzan con -100). Usa `TELEGRAM_ALLOWED_CHATS` para restringir quién puede hablar con el bot por seguridad.

<div id="twitter--x">

### Twitter / X
</div>

**Obtener credenciales:** https://developer.twitter.com/en/portal/dashboard
**Mínimo requerido:** Las 4 claves OAuth: `TWITTER_API_KEY`, `TWITTER_API_SECRET_KEY`, `TWITTER_ACCESS_TOKEN`, `TWITTER_ACCESS_TOKEN_SECRET`
**Variables:**
- `TWITTER_API_KEY` — Clave de API del Consumidor
- `TWITTER_API_SECRET_KEY` — Secreto de API del Consumidor
- `TWITTER_ACCESS_TOKEN` — Token de Acceso (de la pestaña "Keys and Tokens")
- `TWITTER_ACCESS_TOKEN_SECRET` — Secreto del Token de Acceso
- `TWITTER_DRY_RUN` — `true` para probar sin publicar realmente
- `TWITTER_POST_ENABLE` — `true` para habilitar publicaciones autónomas
- `TWITTER_POST_INTERVAL_MIN` / `TWITTER_POST_INTERVAL_MAX` — Minutos entre publicaciones (p. ej. 90/180)
- `TWITTER_POST_IMMEDIATELY` — `true` para publicar al iniciar
- `TWITTER_AUTO_RESPOND_MENTIONS` — `true` para responder a @menciones
- `TWITTER_POLL_INTERVAL` — Segundos entre verificaciones de menciones (p. ej. 120)
- `TWITTER_SEARCH_ENABLE` / `TWITTER_ENABLE_TIMELINE` / `TWITTER_ENABLE_DISCOVERY` — Modos de interacción avanzados
**Pasos de configuración:**
1. Solicita una cuenta de desarrollador en developer.twitter.com (instantáneo para el nivel básico)
2. Crea un Proyecto y una App
3. Genera las 4 claves desde la pestaña "Keys and Tokens"
4. Configura los permisos de la app a Lectura y Escritura
5. Regenera los tokens DESPUÉS de configurar los permisos
**Consejos:** Comienza con `TWITTER_DRY_RUN=true` para verificar sin publicar. El nivel gratuito de la API tiene 500 publicaciones/mes. Necesitas LAS 4 claves OAuth — si falta alguna causará un fallo de autenticación.

<div id="slack">

### Slack
</div>

**Obtener credenciales:** https://api.slack.com/apps → Crear Nueva App
**Mínimo requerido:** `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN`
**Variables:**
- `SLACK_BOT_TOKEN` — Comienza con `xoxb-` (de OAuth & Permissions → Bot Token)
- `SLACK_APP_TOKEN` — Comienza con `xapp-` (de Basic Information → App-Level Tokens; alcance: `connections:write`)
- `SLACK_SIGNING_SECRET` — De Basic Information (para verificación de webhook)
- `SLACK_USER_TOKEN` — Comienza con `xoxp-` (opcional, para acciones a nivel de usuario)
- `SLACK_CHANNEL_IDS` — IDs de canales separados por comas, p. ej. `C01ABCDEF,C02GHIJKL`
- `SLACK_SHOULD_IGNORE_BOT_MESSAGES` — Prevenir bucles de bots
- `SLACK_SHOULD_RESPOND_ONLY_TO_MENTIONS` — Solo responder cuando se le @menciona
**Pasos de configuración:**
1. Crea una app en api.slack.com/apps (Desde Cero → elige el workspace)
2. Modo Socket: Habilita el Modo Socket → genera un App-Level Token con alcance `connections:write`
3. Alcances del Bot Token (OAuth & Permissions): `chat:write`, `channels:read`, `channels:history`, `groups:history`, `im:history`, `app_mentions:read`
4. Instala la app en el workspace → copia el Bot Token
5. Habilita Event Subscriptions → Suscríbete a eventos del bot: `message.channels`, `message.im`, `app_mention`
**Consejos:** El Modo Socket significa que NO necesitas una URL de webhook pública. Tanto el Bot Token (xoxb-) COMO el App Token (xapp-) son necesarios para el Modo Socket. Para obtener IDs de canal: haz clic derecho en el canal en Slack → Copiar enlace, el ID está en la URL.

<div id="whatsapp">

### WhatsApp
</div>

**Dos modos — elige uno:**

**Modo 1: Cloud API (Empresarial, recomendado)**
**Obtener credenciales:** https://developers.facebook.com/apps → WhatsApp → API Setup
- `WHATSAPP_ACCESS_TOKEN` — Token permanente de usuario del sistema de Meta Business
- `WHATSAPP_PHONE_NUMBER_ID` — De WhatsApp → API Setup
- `WHATSAPP_BUSINESS_ACCOUNT_ID` — De la configuración de WhatsApp Business
- `WHATSAPP_WEBHOOK_VERIFY_TOKEN` — Cualquier cadena que elijas (usada para verificar el webhook)
- `WHATSAPP_API_VERSION` — p. ej. `v18.0` (usa la más reciente)
**Configuración:** Necesitas una cuenta de Meta Business, número de teléfono verificado y una App de WhatsApp Business aprobada

**Modo 2: Baileys (Personal, código QR)**
- `WHATSAPP_AUTH_DIR` — Directorio para almacenar archivos de sesión, p. ej. `/data/whatsapp-auth`
- No se necesitan otras credenciales — escanea un código QR en la primera ejecución
**Consejos:** El modo Baileys funciona con tu número personal de WhatsApp pero viola los Términos de Servicio. Usa Cloud API para producción. Cloud API requiere un negocio real y aprobación de la app de Meta.

<div id="instagram">

### Instagram
</div>

**Obtener credenciales:** Usa las credenciales de tu cuenta de Instagram
**Mínimo requerido:** `INSTAGRAM_USERNAME` + `INSTAGRAM_PASSWORD`
**Variables:**
- `INSTAGRAM_USERNAME` — Tu nombre de usuario de Instagram
- `INSTAGRAM_PASSWORD` — Tu contraseña de Instagram
- `INSTAGRAM_VERIFICATION_CODE` — Tu código 2FA si está habilitado
- `INSTAGRAM_PROXY` — URL de proxy si estás limitado o bloqueado
**Consejos:** Usa API no oficial. Instagram bloquea frecuentemente el acceso automatizado. Usa una cuenta dedicada, no la personal. Un proxy reduce los bloqueos. Los usuarios con 2FA deben proporcionar el código al iniciar.

<div id="bluesky">

### Bluesky
</div>

**Obtener credenciales:** https://bsky.app → Configuración → Contraseñas de App
**Mínimo requerido:** `BLUESKY_HANDLE` + `BLUESKY_PASSWORD` (contraseña de app, no tu contraseña real)
**Variables:**
- `BLUESKY_HANDLE` — Tu handle, p. ej. `yourname.bsky.social`
- `BLUESKY_PASSWORD` — Contraseña de app (no tu contraseña de inicio de sesión — crea una en Configuración)
- `BLUESKY_ENABLED` — `true` para habilitar
- `BLUESKY_SERVICE` — Predeterminado: `https://bsky.social` (solo cambia para PDS auto-alojado)
- `BLUESKY_ENABLE_POSTING` — `true` para publicaciones autónomas
- `BLUESKY_POST_INTERVAL_MIN` / `BLUESKY_POST_INTERVAL_MAX` — Segundos entre publicaciones
- `BLUESKY_MAX_POST_LENGTH` — Máximo de caracteres por publicación (predeterminado: 300)
- `BLUESKY_POLL_INTERVAL` — Segundos entre verificaciones de menciones/DMs
- `BLUESKY_ENABLE_DMS` — `true` para responder a mensajes directos
**Consejos:** Crea una Contraseña de App en bsky.app → Configuración → Contraseñas de App. Nunca uses tu contraseña principal de inicio de sesión.

<div id="farcaster">

### Farcaster
</div>

**Obtener credenciales:** https://warpcast.com → Configuración, luego https://neynar.com para la API
**Mínimo requerido:** `FARCASTER_FID` + `FARCASTER_SIGNER_UUID` + `FARCASTER_NEYNAR_API_KEY`
**Variables:**
- `FARCASTER_FID` — Tu ID de Farcaster (número mostrado en la URL del perfil)
- `FARCASTER_SIGNER_UUID` — UUID del firmante del panel de Neynar
- `FARCASTER_NEYNAR_API_KEY` — De neynar.com (necesario para lectura/escritura)
- `ENABLE_CAST` — `true` para habilitar casting autónomo
- `CAST_INTERVAL_MIN` / `CAST_INTERVAL_MAX` — Minutos entre casts
- `MAX_CAST_LENGTH` — Predeterminado 320 caracteres
- `FARCASTER_POLL_INTERVAL` — Segundos entre verificaciones de notificaciones
- `FARCASTER_HUB_URL` — Hub de Farcaster personalizado (avanzado, deja en blanco para el predeterminado)
**Pasos de configuración:**
1. Crea una cuenta en Warpcast, obtén tu FID de la URL de tu perfil
2. Regístrate en neynar.com, crea un firmante para tu FID
3. Obtén tu clave de API del panel de Neynar
**Consejos:** Neynar es obligatorio — es el indexador que hace accesibles los datos de Farcaster a través de la API.

<div id="wechat">

### WeChat
</div>

**Obtener credenciales:** De tu proveedor de servicio proxy de WeChat
**Mínimo requerido:** `WECHAT_API_KEY` + URL de proxy en la configuración
**Variables:**
- `WECHAT_API_KEY` — Clave de API del servicio proxy
**Campos solo de configuración** (se establecen en `connectors.wechat`, no como variables de entorno):
- `proxyUrl` — **Requerido** — La URL de tu servicio proxy de WeChat
- `webhookPort` — Puerto del listener de webhook (predeterminado: 18790)
- `deviceType` — Emulación de dispositivo: `ipad` (predeterminado) o `mac`
- `features.images` — Habilitar envío/recepción de imágenes (predeterminado: false)
- `features.groups` — Habilitar soporte de chat grupal (predeterminado: false)
**Pasos de configuración:**
1. Obtén la clave de API de tu servicio proxy de WeChat
2. Configura `connectors.wechat` en eliza.json con `apiKey` y `proxyUrl`
3. Inicia Eliza — escanea el código QR mostrado en la terminal con WeChat
**Consejos:** WeChat usa un servicio proxy de terceros, no una API oficial. Solo usa un proxy en el que confíes — ve todo el tráfico de mensajes. Se soportan múltiples cuentas a través del mapa `accounts`. Paquete: `@elizaos/plugin-wechat`.

<div id="github">

### GitHub
</div>

**Obtener credenciales:** https://github.com/settings/tokens → Fine-grained o Classic
**Mínimo requerido:** `GITHUB_API_TOKEN`
**Variables:**
- `GITHUB_API_TOKEN` — Token de acceso personal o token de GitHub App
- `GITHUB_OWNER` — Propietario del repositorio (nombre de usuario u organización)
- `GITHUB_REPO` — Nombre del repositorio
- `GITHUB_BRANCH` — Rama predeterminada (p. ej. `main`)
- `GITHUB_WEBHOOK_SECRET` — Para verificación de webhook de GitHub App
- `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` / `GITHUB_INSTALLATION_ID` — Para GitHub Apps
**Consejos:** Los tokens fine-grained son más seguros — limita el alcance solo a los repositorios que necesitas. Para repositorios de organizaciones, puede que necesites solicitar acceso a la organización.

<div id="twitch">

### Twitch
</div>

**Obtener credenciales:** https://dev.twitch.tv/console/apps → Registrar Tu Aplicación
**Mínimo requerido:** `TWITCH_USERNAME` + `TWITCH_CLIENT_ID` + `TWITCH_ACCESS_TOKEN` + `TWITCH_CLIENT_SECRET`
**Variables:**
- `TWITCH_USERNAME` — El nombre de usuario de tu bot de Twitch
- `TWITCH_CLIENT_ID` — De la Consola de Desarrollador de Twitch
- `TWITCH_CLIENT_SECRET` — De la Consola de Desarrollador de Twitch
- `TWITCH_ACCESS_TOKEN` — Token OAuth (obtén vía https://twitchapps.com/tmi/ o flujo OAuth de Twitch)
- `TWITCH_REFRESH_TOKEN` — Para sesiones de larga duración
- `TWITCH_CHANNEL` — Canal principal para unirse (p. ej. `mychannel`)
- `TWITCH_CHANNELS` — Canales adicionales (separados por comas)
- `TWITCH_REQUIRE_MENTION` — `true` para solo responder cuando se menciona el nombre del bot
- `TWITCH_ALLOWED_ROLES` — `broadcaster`, `moderator`, `vip`, `subscriber`, `viewer`
**Consejos:** Crea una cuenta de Twitch separada para el bot. Usa https://twitchapps.com/tmi/ para obtener un token de acceso para bots de chat rápidamente.

<div id="twilio-sms--voice">

### Twilio (SMS + Voz)
</div>

**Obtener credenciales:** https://console.twilio.com
**Mínimo requerido:** `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN` + `TWILIO_PHONE_NUMBER`
**Variables:**
- `TWILIO_ACCOUNT_SID` — Del panel de la Consola de Twilio (comienza con `AC`)
- `TWILIO_AUTH_TOKEN` — Del panel de la Consola de Twilio
- `TWILIO_PHONE_NUMBER` — Tu número de Twilio en formato E.164 (p. ej. `+15551234567`)
- `TWILIO_WEBHOOK_URL` — Tu URL públicamente accesible para mensajes entrantes
- `TWILIO_WEBHOOK_PORT` — Puerto de escucha (si es auto-alojado, predeterminado 3000)
- `VOICE_CALL_PROVIDER` — p. ej. `twilio`
- `VOICE_CALL_FROM_NUMBER` — ID de llamada saliente
- `VOICE_CALL_TO_NUMBER` — Número predeterminado para llamar
- `VOICE_CALL_PUBLIC_URL` — URL públicamente accesible para webhooks de voz
- `VOICE_CALL_MAX_DURATION_SECONDS` — Duración máxima de llamada (predeterminado 3600)
- `VOICE_CALL_INBOUND_POLICY` — `allow-all`, `allow-from` o `deny-all`
- `VOICE_CALL_INBOUND_GREETING` — Texto hablado cuando se contesta la llamada
**Consejos:** Para que los webhooks funcionen, Twilio necesita una URL pública. Usa ngrok durante el desarrollo. Obtén un número de teléfono en Console → Phone Numbers → Buy a Number. La prueba gratuita ofrece ~$15 de crédito.

<div id="matrix">

### Matrix
</div>

**Obtener credenciales:** Tu cuenta del homeserver de Matrix
**Mínimo requerido:** `MATRIX_HOMESERVER` + `MATRIX_USER_ID` + `MATRIX_ACCESS_TOKEN`
**Variables:**
- `MATRIX_HOMESERVER` — p. ej. `https://matrix.org` o tu propio homeserver
- `MATRIX_USER_ID` — p. ej. `@yourbot:matrix.org`
- `MATRIX_ACCESS_TOKEN` — De Element: Configuración → Ayuda y Acerca de → Avanzado → Access Token
- `MATRIX_DEVICE_ID` — Deja en blanco para asignación automática
- `MATRIX_ROOMS` — IDs de sala separados por comas (p. ej. `!abc123:matrix.org`)
- `MATRIX_AUTO_JOIN` — `true` para unirse automáticamente a salas invitadas
- `MATRIX_ENCRYPTION` — `true` para habilitar cifrado E2E (requiere más configuración)
- `MATRIX_REQUIRE_MENTION` — `true` para solo responder cuando se le @menciona
**Consejos:** Obtén tu token de acceso en Element → Configuración → Ayuda y Acerca de → Avanzado. Los IDs de Matrix usan el formato `@user:server`.

<div id="microsoft-teams">

### Microsoft Teams
</div>

**Obtener credenciales:** https://portal.azure.com → Azure Active Directory → App Registrations
**Mínimo requerido:** `MSTEAMS_APP_ID` + `MSTEAMS_APP_PASSWORD` + `MSTEAMS_TENANT_ID`
**Variables:**
- `MSTEAMS_APP_ID` — ID de Aplicación (cliente) del portal de Azure
- `MSTEAMS_APP_PASSWORD` — Valor del secreto de cliente del portal de Azure
- `MSTEAMS_TENANT_ID` — Tu ID de inquilino de Azure AD
- `MSTEAMS_WEBHOOK_PORT` / `MSTEAMS_WEBHOOK_PATH` — Donde Bot Framework envía los mensajes
- `MSTEAMS_ALLOWED_TENANTS` — Restringir a inquilinos específicos (separados por comas)
- `MSTEAMS_SHAREPOINT_SITE_ID` — Para integración con SharePoint (avanzado)
- `MSTEAMS_MEDIA_MAX_MB` — Tamaño máximo de carga de archivos (predeterminado 25MB)
**Pasos de configuración:**
1. Registra la app en el portal de Azure → App Registrations → New Registration
2. Agrega un secreto de cliente en Certificates & Secrets
3. Registra el bot vía https://dev.botframework.com → Create a bot
4. Conecta el bot al canal de Microsoft Teams en el portal de Bot Framework
**Consejos:** Requiere acceso de administrador de Microsoft 365 o una organización que permita registros de apps.

<div id="google-chat">

### Google Chat
</div>

**Obtener credenciales:** https://console.cloud.google.com → APIs → Google Chat API
**Mínimo requerido:** JSON de cuenta de servicio o ruta de `GOOGLE_APPLICATION_CREDENTIALS`
**Variables:**
- `GOOGLE_CHAT_SERVICE_ACCOUNT_KEY` — JSON completo de la cuenta de servicio (pega el JSON completo)
- `GOOGLE_CHAT_SERVICE_ACCOUNT_FILE` — Alternativa: ruta al archivo JSON de la cuenta de servicio
- `GOOGLE_APPLICATION_CREDENTIALS` — Alternativa: ruta al archivo de credenciales
- `GOOGLE_CHAT_SPACES` — Nombres de espacios separados por comas (p. ej. `spaces/AAAA_space_id`)
- `GOOGLE_CHAT_AUDIENCE_TYPE` — `PUBLISHED` o `DOMAIN_INSTALL`
- `GOOGLE_CHAT_AUDIENCE` — La URL de audiencia de tu app
- `GOOGLE_CHAT_WEBHOOK_PATH` — Ruta de webhook para mensajes entrantes
- `GOOGLE_CHAT_REQUIRE_MENTION` — `true` para requerir @mención
- `GOOGLE_CHAT_BOT_USER` — ID de usuario del bot
**Consejos:** Habilita la API de Google Chat en Cloud Console. Crea una cuenta de servicio con permisos de alcance de Chat. El administrador del Workspace debe aprobar la app de Chat.

<div id="signal">

### Signal
</div>

**Obtener credenciales:** Tu propio número de teléfono + signal-cli o signal-api-rest-api
**Mínimo requerido:** `SIGNAL_ACCOUNT_NUMBER` + `SIGNAL_HTTP_URL`
**Variables:**
- `SIGNAL_ACCOUNT_NUMBER` — Tu número de teléfono en formato E.164 (p. ej. `+15551234567`)
- `SIGNAL_HTTP_URL` — URL de la API REST, p. ej. `http://localhost:8080`
- `SIGNAL_CLI_PATH` — Ruta al binario de signal-cli (opcional, para modo CLI directo)
- `SIGNAL_SHOULD_IGNORE_GROUP_MESSAGES` — `true` para ignorar chats grupales
**Configuración:** Ejecuta el servidor signal-api-rest-api: https://github.com/bbernhard/signal-cli-rest-api
**Consejos:** Signal no tiene una API oficial. Usa la imagen Docker bbernhard/signal-cli-rest-api — maneja la conexión de signal-cli y expone una API REST.

<div id="imessage-macos-only">

### iMessage (solo macOS)
</div>

**Obtener credenciales:** Solo macOS — no se necesitan credenciales, usa la app Mensajes local
**Variables:**
- `IMESSAGE_CLI_PATH` — Ruta al CLI de imessage-reader (instalar desde GitHub)
- `IMESSAGE_DB_PATH` — Ruta a la base de datos chat.db de Mensajes (predeterminado: `~/Library/Messages/chat.db`)
- `IMESSAGE_POLL_INTERVAL_MS` — Con qué frecuencia verificar nuevos mensajes (predeterminado: 5000ms)
- `IMESSAGE_DM_POLICY` — `allow-all` o `allow-from`
- `IMESSAGE_GROUP_POLICY` — `allow-all`, `allow-from` o `deny-all`
- `IMESSAGE_ALLOW_FROM` — Remitentes permitidos separados por comas
- `IMESSAGE_ENABLED` — `true` para habilitar
**Consejos:** Solo macOS. Requiere permiso de Acceso Total al Disco para que la app lea la base de datos de Mensajes. Solo funciona en la máquina que tiene iMessage configurado.

<div id="blooio-sms-via-api">

### Blooio (SMS vía API)
</div>

**Obtener credenciales:** https://bloo.io
**Mínimo requerido:** `BLOOIO_API_KEY`
**Variables:**
- `BLOOIO_API_KEY` — Del panel de bloo.io
- `BLOOIO_WEBHOOK_URL` — Tu URL pública para webhooks de SMS entrantes
- `BLOOIO_WEBHOOK_SECRET` — Secreto para verificación de firma del webhook
- `BLOOIO_BASE_URL` — URL base de la API de bloo.io (deja como predeterminado)
- `BLOOIO_PHONE_NUMBER` — Número de teléfono desde el que enviar
- `BLOOIO_WEBHOOK_PORT` — Puerto para el listener del webhook
**Consejos:** Blooio conecta iMessage/SMS. Requiere un Mac ejecutando la app de Blooio.

<div id="nostr">

### Nostr
</div>

**Obtener credenciales:** Genera tu propio par de claves usando cualquier cliente Nostr
**Mínimo requerido:** `NOSTR_PRIVATE_KEY`
**Variables:**
- `NOSTR_PRIVATE_KEY` — Tu clave privada nsec (formato hex)
- `NOSTR_RELAYS` — URLs de relays separadas por comas, p. ej. `wss://relay.damus.io,wss://relay.nostr.band`
- `NOSTR_DM_POLICY` — `allow-all` o `allow-from`
- `NOSTR_ALLOW_FROM` — Claves públicas permitidas (formato npub)
- `NOSTR_ENABLED` — `true` para habilitar
**Consejos:** Genera claves con cualquier app de Nostr (Damus, Primal, Amethyst). Mantén la clave privada en secreto — es tu identidad. Usa múltiples relays para mayor fiabilidad.

<div id="line">

### LINE
</div>

**Obtener credenciales:** https://developers.line.biz/console
**Mínimo requerido:** `LINE_CHANNEL_ACCESS_TOKEN` + `LINE_CHANNEL_SECRET`
**Variables:**
- `LINE_CHANNEL_ACCESS_TOKEN` — De la consola de LINE Developers → Messaging API → Channel Access Token
- `LINE_CHANNEL_SECRET` — De la pestaña Basic Settings
- `LINE_WEBHOOK_PATH` — Ruta de URL del webhook (configura también en la consola de LINE)
- `LINE_DM_POLICY` / `LINE_GROUP_POLICY` — `allow-all` o `allow-from`
- `LINE_ALLOW_FROM` — IDs de usuario permitidos
- `LINE_ENABLED` — `true` para habilitar
**Pasos de configuración:**
1. Crea un canal en developers.line.biz
2. Emite un token de acceso al canal (de larga duración, en la pestaña Messaging API)
3. Configura tu URL de webhook en la consola
**Consejos:** LINE requiere que tu webhook sea HTTPS con un certificado válido. Usa ngrok o despliega en un servidor para desarrollo.

<div id="feishu-lark">

### Feishu (Lark)
</div>

**Obtener credenciales:** https://open.feishu.cn (o open.larksuite.com para Lark)
**Mínimo requerido:** `FEISHU_APP_ID` + `FEISHU_APP_SECRET`
**Variables:**
- `FEISHU_APP_ID` — De la Consola de Desarrollador de Feishu/Lark → Credenciales de App
- `FEISHU_APP_SECRET` — De la sección de Credenciales de App
- `FEISHU_DOMAIN` — `feishu.cn` (predeterminado) o `larksuite.com`
- `FEISHU_ALLOWED_CHATS` — IDs de chat permitidos (separados por comas)
- `FEISHU_TEST_CHAT_ID` — Para pruebas

<div id="mattermost">

### Mattermost
</div>

**Obtener credenciales:** Tu instancia de Mattermost → System Console → Integrations → Bot Accounts
**Mínimo requerido:** `MATTERMOST_SERVER_URL` + `MATTERMOST_BOT_TOKEN`
**Variables:**
- `MATTERMOST_SERVER_URL` — p. ej. `https://mattermost.yourcompany.com`
- `MATTERMOST_BOT_TOKEN` — De System Console → Bot Accounts → Add Bot Account
- `MATTERMOST_TEAM_ID` — Tu ID de equipo (de la URL del equipo o la API)
- `MATTERMOST_DM_POLICY` / `MATTERMOST_GROUP_POLICY` — `allow-all` o `allow-from`
- `MATTERMOST_ALLOWED_USERS` / `MATTERMOST_ALLOWED_CHANNELS` — Restringir acceso
- `MATTERMOST_REQUIRE_MENTION` — `true` para requerir @mención
**Consejos:** Habilita Bot Accounts en System Console → Authentication → Bot Accounts. Mattermost auto-alojado es gratuito.

<div id="nextcloud-talk">

### Nextcloud Talk
</div>

**Obtener credenciales:** Tu instancia de Nextcloud → Configuración → Seguridad → Contraseñas de App
**Mínimo requerido:** `NEXTCLOUD_URL` + `NEXTCLOUD_BOT_SECRET`
**Variables:**
- `NEXTCLOUD_URL` — Tu URL de Nextcloud (p. ej. `https://cloud.yourserver.com`)
- `NEXTCLOUD_BOT_SECRET` — Establecido al registrar el bot vía la API de Nextcloud Talk
- `NEXTCLOUD_WEBHOOK_PUBLIC_URL` — URL públicamente accesible para webhooks de Talk
- `NEXTCLOUD_WEBHOOK_PORT` / `NEXTCLOUD_WEBHOOK_PATH` — Configuración del servidor de webhook
- `NEXTCLOUD_ALLOWED_ROOMS` — Tokens de sala permitidos

<div id="tlon-urbit">

### Tlon (Urbit)
</div>

**Obtener credenciales:** Acceso a tu nave Urbit
**Mínimo requerido:** `TLON_SHIP` + `TLON_URL` + `TLON_CODE`
**Variables:**
- `TLON_SHIP` — El nombre de tu nave (p. ej. `~sampel-palnet`)
- `TLON_URL` — URL a tu nave (p. ej. `http://localhost:8080`)
- `TLON_CODE` — El código de acceso de tu nave (de `+code` en Dojo)
- `TLON_GROUP_CHANNELS` — Canales para escuchar (formato de ruta de grupo)
- `TLON_DM_ALLOWLIST` — Remitentes de DM permitidos
- `TLON_AUTO_DISCOVER_CHANNELS` — Auto-unirse a canales

<div id="zalo-vietnam-messaging">

### Zalo (Mensajería de Vietnam)
</div>

**Obtener credenciales:** https://developers.zalo.me
**Mínimo requerido:** `ZALO_APP_ID` + `ZALO_SECRET_KEY` + `ZALO_ACCESS_TOKEN`
**Variables:**
- `ZALO_APP_ID` / `ZALO_SECRET_KEY` — Del portal de Desarrolladores de Zalo
- `ZALO_ACCESS_TOKEN` / `ZALO_REFRESH_TOKEN` — Tokens OAuth de Zalo
- `ZALO_WEBHOOK_URL` / `ZALO_WEBHOOK_PATH` / `ZALO_WEBHOOK_PORT` — Configuración de webhook

<div id="zalo-user-personal">

### Zalo User (Personal)
</div>

Conector de cuenta personal de Zalo (no oficial, no se necesita clave de API).
**Variables:**
- `ZALOUSER_COOKIE_PATH` — Ruta a las cookies de sesión exportadas de Zalo
- `ZALOUSER_IMEI` — IMEI del dispositivo para la sesión (de la app oficial de Zalo)
- `ZALOUSER_USER_AGENT` — Cadena de user agent del navegador
- `ZALOUSER_PROFILES` — Múltiples perfiles de cuenta (JSON)
- `ZALOUSER_ALLOWED_THREADS` — Hilos de conversación permitidos
- `ZALOUSER_DM_POLICY` / `ZALOUSER_GROUP_POLICY` — Políticas de mensajes

<div id="acp-agent-communication-protocol">

### ACP (Protocolo de Comunicación entre Agentes)
</div>

Protocolo interno de agente a agente para conectar múltiples agentes de IA.
**Variables:**
- `ACP_GATEWAY_URL` — URL del gateway para el hub ACP
- `ACP_GATEWAY_TOKEN` / `ACP_GATEWAY_PASSWORD` — Credenciales de autenticación
- `ACP_DEFAULT_SESSION_KEY` / `ACP_DEFAULT_SESSION_LABEL` — Identificación de sesión
- `ACP_CLIENT_NAME` / `ACP_CLIENT_DISPLAY_NAME` — Identidad de este agente
- `ACP_AGENT_ID` — ID único del agente
- `ACP_PERSIST_SESSIONS` — `true` para guardar sesiones entre reinicios
- `ACP_SESSION_STORE_PATH` — Dónde guardar las sesiones

<div id="mcp-model-context-protocol">

### MCP (Protocolo de Contexto de Modelo)
</div>

Conéctate a cualquier servidor MCP para capacidades extendidas de herramientas.
**Variables:**
- `mcp` — Objeto de configuración JSON para servidores MCP
**Consejos:** Los servidores MCP pueden proporcionar herramientas (búsqueda web, ejecución de código, acceso a archivos, bases de datos, etc.) directamente a la IA. Consulta https://modelcontextprotocol.io para servidores disponibles.

<div id="iq-solana-on-chain">

### IQ (Solana On-chain)
</div>

Chat on-chain a través de la blockchain de Solana.
**Mínimo requerido:** `SOLANA_PRIVATE_KEY` + `IQ_GATEWAY_URL`
**Variables:**
- `SOLANA_PRIVATE_KEY` — Clave privada de la billetera Solana (codificada en base58)
- `SOLANA_KEYPAIR_PATH` — Alternativa: ruta al archivo JSON del par de claves
- `SOLANA_RPC_URL` — p. ej. `https://api.mainnet-beta.solana.com`
- `IQ_GATEWAY_URL` — URL del gateway del protocolo IQ
- `IQ_AGENT_NAME` — Nombre visible de tu agente
- `IQ_DEFAULT_CHATROOM` — Sala de chat predeterminada para unirse
- `IQ_CHATROOMS` — Salas de chat adicionales (separadas por comas)

<div id="gmail-watch">

### Gmail Watch
</div>

Monitorea Gmail a través de notificaciones push de Google Pub/Sub.
**Configuración:** Requiere una cuenta de servicio de Google Cloud con acceso a la API de Gmail.
**Consejos:** Usa `gog gmail watch serve` internamente. Requiere un proyecto de Google Cloud con la API de Gmail habilitada y Pub/Sub configurado.

---

<div id="streaming"></div>

## Transmisión (Emisión en Vivo)

### Pestaña Stream (`streaming`)

Agrega la pestaña Stream a la UI con gestión de destinos RTMP. Habilita **`@elizaos/plugin-streaming`** una sola vez; cubre Twitch, YouTube, X, pump.fun, RTMP personalizado y, opcionalmente, ingestos nombrados vía `streaming.rtmpSources`.

### Transmisión en Twitch

**Obtener credenciales:** https://dashboard.twitch.tv → Settings → Stream
**Variable:** `TWITCH_STREAM_KEY` — Tu clave de transmisión (mantenla en secreto!)
**Consejos:** Nunca compartas tu clave de transmisión — permite que cualquiera transmita en tu canal. Regénérala si se filtra.

### Transmisión en YouTube

**Obtener credenciales:** https://studio.youtube.com → Go Live → Stream settings
**Variables:**
- `YOUTUBE_STREAM_KEY` — De YouTube Studio → Stream key
- `YOUTUBE_RTMP_URL` — Predeterminado: `rtmp://a.rtmp.youtube.com/live2` (rara vez necesita cambios)
**Consejos:** Necesitas un canal de YouTube con transmisión en vivo habilitada (puede requerir verificación telefónica).

### Transmisión en X

Transmite en vivo a X usando credenciales RTMP generadas para la emisión activa.
**Obtener credenciales:** De X Live Producer / Media Studio al crear una transmisión en vivo
**Variables:**
- `X_STREAM_KEY` — Clave de transmisión para la emisión
- `X_RTMP_URL` — URL de ingestión RTMP para la sesión de emisión
**Consejos:** Las credenciales RTMP de X suelen ser por emisión. Crea la transmisión primero, luego copia ambos valores directamente en el plugin.

### Transmisión en pump.fun

Transmite a pump.fun usando las credenciales de ingestión RTMP de la plataforma.
**Obtener credenciales:** Del flujo de transmisión en vivo de pump.fun al crear una transmisión
**Variables:**
- `PUMPFUN_STREAM_KEY` — Clave de transmisión para la ingestión de pump.fun
- `PUMPFUN_RTMP_URL` — URL de ingestión RTMP para la transmisión actual
**Consejos:** Trata ambos valores como credenciales de sesión. Si la transmisión no inicia, recrea la emisión y pega valores nuevos.

### RTMP Personalizado

Transmite a cualquier plataforma (Facebook, TikTok, Kick, RTMP auto-alojado, etc.)
**Variables:**
- `CUSTOM_RTMP_URL` — URL del endpoint RTMP, p. ej. `rtmp://live.kick.com/app`
- `CUSTOM_RTMP_KEY` — Clave de transmisión de la plataforma
**URLs RTMP comunes:**
- Facebook Live: `rtmps://live-api-s.facebook.com:443/rtmp/`
- TikTok: `rtmp://push.tiktokcdn.com/third/` (se necesita acceso a TikTok Live)
- Kick: `rtmp://ingest.global-contribute.live-video.net/app`

---

<div id="general-tips">

## Consejos Generales
</div>

**Requerido vs Opcional:** Cada plugin tiene campos mínimos requeridos. Comienza solo con esos — puedes agregar configuraciones opcionales después.

**Probar antes de ir en vivo:** La mayoría de los conectores tienen un modo de "ejecución en seco" (p. ej. `TWITTER_DRY_RUN=true`, `FARCASTER_DRY_RUN=true`, `BLUESKY_DRY_RUN=true`) — úsalo para verificar la configuración sin publicar.

**Campos de política:** La mayoría de los conectores tienen campos `DM_POLICY` y `GROUP_POLICY`:
- `allow-all` — responder a todos
- `allow-from` — solo responder a cuentas en la lista `ALLOW_FROM`
- `deny-all` — nunca responder (efectivamente deshabilita ese tipo de canal)

**Webhook vs Polling:** Conectores como LINE, Twilio, WhatsApp Cloud API y Google Chat usan webhooks (envían mensajes a tu servidor). Necesitas una URL públicamente accesible. Usa ngrok para desarrollo local: `ngrok http 3000`.

**Límites de tasa:** La mayoría de las plataformas aplican límites de tasa. Para Twitter especialmente, usa intervalos de publicación conservadores (90-180 minutos como mínimo).

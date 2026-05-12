---
title: "Plugin de Slack"
sidebarTitle: "Slack"
description: "Conector de Slack para Eliza — bot de espacio de trabajo, monitoreo de canales, comandos slash y componentes interactivos."
---

El plugin de Slack conecta agentes de Eliza a espacios de trabajo de Slack como una aplicación bot, gestionando mensajes en canales, mensajes directos e hilos con soporte para comandos slash y componentes interactivos.

**Package:** `@elizaos/plugin-slack`

<div id="installation">
## Instalación
</div>

```bash
eliza plugins install @elizaos/plugin-slack
```

<div id="setup">
## Configuración
</div>

<div id="1-create-a-slack-app">
### 1. Crear una aplicación de Slack
</div>

1. Ve a [api.slack.com/apps](https://api.slack.com/apps)
2. Haz clic en **Create New App → From scratch**
3. Nombra la aplicación y selecciona tu espacio de trabajo

<div id="2-configure-bot-permissions">
### 2. Configurar permisos del bot
</div>

Navega a **OAuth & Permissions → Scopes → Bot Token Scopes** y agrega:

| Scope | Propósito |
|-------|-----------|
| `app_mentions:read` | Recibir @menciones |
| `channels:history` | Leer mensajes del canal |
| `channels:read` | Listar canales |
| `chat:write` | Publicar mensajes |
| `groups:history` | Leer mensajes de canales privados |
| `im:history` | Leer historial de mensajes directos |
| `im:read` | Acceder a información de mensajes directos |
| `im:write` | Enviar mensajes directos |
| `mpim:history` | Leer historial de mensajes directos grupales |
| `reactions:write` | Agregar reacciones |
| `users:read` | Buscar información de usuario |

<div id="3-enable-socket-mode-recommended-for-development">
### 3. Habilitar Socket Mode (Recomendado para desarrollo)
</div>

Navega a **Socket Mode** y actívalo. Genera un Token de nivel de aplicación con el scope `connections:write`.

<div id="4-enable-event-subscriptions">
### 4. Habilitar suscripciones de eventos
</div>

Navega a **Event Subscriptions** y suscríbete a los eventos del bot:

- `app_mention`
- `message.channels`
- `message.groups`
- `message.im`
- `message.mpim`

<div id="5-install-to-workspace">
### 5. Instalar en el espacio de trabajo
</div>

Navega a **OAuth & Permissions** y haz clic en **Install to Workspace**. Copia el **Bot User OAuth Token** (`xoxb-...`).

<div id="6-configure-eliza">
### 6. Configurar Eliza
</div>

```json
{
  "connectors": {
    "slack": {
      "botToken": "<SLACK_BOT_TOKEN>",
      "appToken": "<SLACK_APP_TOKEN>"
    }
  }
}
```

<div id="configuration">
## Configuración
</div>

| Campo | Requerido | Descripción |
|-------|-----------|-------------|
| `botToken` | Sí | Bot User OAuth Token (`xoxb-...`) |
| `appToken` | No | Token de nivel de aplicación para Socket Mode (`xapp-...`) |
| `signingSecret` | No | Secreto de firma para verificación de webhook |
| `enabled` | No | Establecer `false` para deshabilitar (por defecto: `true`) |
| `allowedChannels` | No | Array de IDs de canales donde responder |

<div id="features">
## Características
</div>

- **Comandos slash** — Registrar y responder a `/commands`
- **@menciones** — Responde cuando se le menciona en canales
- **Mensajes directos** — Soporte completo de conversaciones privadas
- **Hilos** — Participa en respuestas en hilos
- **Reacciones** — Agrega reacciones con emoji a los mensajes
- **Socket Mode** — Entrega de eventos en tiempo real sin una URL pública
- **Modo webhook** — Soporte de endpoint webhook para producción
- **Componentes interactivos** — Botones y modales de Block Kit

<div id="message-flow">
## Flujo de mensajes
</div>

```
Evento de Slack (vía Socket Mode o webhook)
       ↓
El plugin valida la firma del evento
       ↓
Determina el contexto de respuesta:
  - app_mention → responder en hilo del canal
  - message.im → responder en mensaje directo
       ↓
AgentRuntime procesa el mensaje
       ↓
Respuesta publicada en canal/mensaje directo de Slack
```

<div id="auto-enable">
## Activación automática
</div>

El plugin se activa automáticamente cuando `connectors.slack.botToken` está configurado.

<div id="thread-behavior">
## Comportamiento de hilos
</div>

Por defecto, las respuestas se publican como respuestas en hilos para mantener los canales limpios. Para publicar respuestas de nivel superior:

```json
{
  "connectors": {
    "slack": {
      "botToken": "<SLACK_BOT_TOKEN>",
      "replyInThread": false
    }
  }
}
```

<div id="related">
## Relacionado
</div>

- [Plugin de Discord](/plugin-registry/platform/discord) — Integración con bot de Discord
- [Plugin de Telegram](/plugin-registry/platform/telegram) — Integración con bot de Telegram
- [Guía de conectores](/es/guides/connectors) — Documentación general de conectores

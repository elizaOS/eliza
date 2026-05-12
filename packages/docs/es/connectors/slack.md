---
title: Conector de Slack
sidebarTitle: Slack
description: Conecta tu agente a espacios de trabajo de Slack usando el paquete @elizaos/plugin-slack.
---

<div id="overview">

## Descripción general

</div>

El conector de Slack es un plugin externo de elizaOS que conecta tu agente a espacios de trabajo de Slack. Soporta dos modos de transporte (Socket Mode y webhooks HTTP), configuración por canal, políticas de mensajes directos, comandos de barra, soporte multi-cuenta y permisos de acciones detallados. El conector se habilita automáticamente por el runtime cuando se detecta un token válido en la configuración de tu conector.

<div id="package-info">

## Información del paquete

</div>

| Campo | Valor |
|-------|-------|
| Paquete | `@elizaos/plugin-slack` |
| Clave de configuración | `connectors.slack` |
| Activación automática | `botToken`, `token` o `apiKey` es verdadero en la configuración del conector |

<div id="minimal-configuration">

## Configuración mínima

</div>

En `~/.eliza/eliza.json`:

```json
{
  "connectors": {
    "slack": {
      "botToken": "xoxb-your-bot-token"
    }
  }
}
```

<div id="disabling">

## Desactivación

</div>

Para desactivar explícitamente el conector incluso cuando un token está presente:

```json
{
  "connectors": {
    "slack": {
      "botToken": "xoxb-your-bot-token",
      "enabled": false
    }
  }
}
```

<div id="auto-enable-mechanism">

## Mecanismo de habilitación automática

</div>

El módulo `plugin-auto-enable.ts` verifica `connectors.slack` en tu configuración. Si alguno de los campos `botToken`, `token` o `apiKey` es verdadero (y `enabled` no es explícitamente `false`), el runtime carga automáticamente `@elizaos/plugin-slack`.

No se requiere ninguna variable de entorno para activar la habilitación automática — se controla completamente por el objeto de configuración del conector.

<div id="environment-variables">

## Variables de entorno

</div>

Cuando el conector se carga, el runtime envía los siguientes secretos de tu configuración a `process.env` para que el plugin los consuma:

| Variable | Fuente | Descripción |
|----------|--------|-------------|
| `SLACK_BOT_TOKEN` | `botToken` | Token del bot (`xoxb-...`) |
| `SLACK_APP_TOKEN` | `appToken` | Token a nivel de aplicación (`xapp-...`) para Socket Mode |
| `SLACK_USER_TOKEN` | `userToken` | Token de usuario (`xoxp-...`) para acciones con alcance de usuario |

<div id="transport-modes">

## Modos de transporte

</div>

Slack soporta dos modos de transporte:

<div id="socket-mode-default">

### Socket Mode (predeterminado)

</div>

Usa WebSocket a través de la API de Socket Mode de Slack. Requiere un token a nivel de aplicación (`xapp-...`).

```json
{
  "connectors": {
    "slack": {
      "mode": "socket",
      "botToken": "<SLACK_BOT_TOKEN>",
      "appToken": "<SLACK_APP_TOKEN>"
    }
  }
}
```

<div id="http-mode">

### Modo HTTP

</div>

Recibe eventos a través de webhooks HTTP. Requiere un secreto de firma para la verificación de solicitudes.

```json
{
  "connectors": {
    "slack": {
      "mode": "http",
      "botToken": "<SLACK_BOT_TOKEN>",
      "signingSecret": "your-signing-secret",
      "webhookPath": "/slack/events"
    }
  }
}
```

Cuando `mode` es `"http"`, `signingSecret` es requerido (validado por el esquema).

<div id="full-configuration-reference">

## Referencia completa de configuración

</div>

Todos los campos bajo `connectors.slack`:

| Campo | Tipo | Predeterminado | Descripción |
|-------|------|----------------|-------------|
| `botToken` | string | — | Token del bot (`xoxb-...`) |
| `appToken` | string | — | Token a nivel de aplicación (`xapp-...`) para Socket Mode |
| `userToken` | string | — | Token de usuario (`xoxp-...`) para llamadas API con alcance de usuario |
| `userTokenReadOnly` | boolean | `true` | Restringir el token de usuario a operaciones de solo lectura |
| `mode` | `"socket"` \| `"http"` | `"socket"` | Modo de transporte |
| `signingSecret` | string | — | Secreto de firma para modo HTTP (requerido cuando mode es `"http"`) |
| `webhookPath` | string | `"/slack/events"` | Ruta del endpoint de webhook HTTP |
| `name` | string | — | Nombre de visualización de la cuenta |
| `enabled` | boolean | — | Habilitar/deshabilitar explícitamente |
| `capabilities` | string[] | — | Banderas de capacidades |
| `allowBots` | boolean | `false` | Permitir que mensajes de bots activen respuestas |
| `requireMention` | boolean | — | Solo responder cuando se mencione con @ |
| `groupPolicy` | `"open"` \| `"disabled"` \| `"allowlist"` | `"allowlist"` | Política de unión a grupos/canales |
| `historyLimit` | integer >= 0 | — | Máximo de mensajes en el contexto de conversación |
| `dmHistoryLimit` | integer >= 0 | — | Límite de historial para mensajes directos |
| `dms` | Record\<string, \{historyLimit?\}\> | — | Sobrecargas de historial por mensaje directo |
| `textChunkLimit` | integer > 0 | — | Máximo de caracteres por fragmento de mensaje |
| `chunkMode` | `"length"` \| `"newline"` | — | Estrategia de división de mensajes largos |
| `blockStreaming` | boolean | — | Deshabilitar respuestas en streaming |
| `blockStreamingCoalesce` | object | — | Coalescencia: `minChars`, `maxChars`, `idleMs` |
| `mediaMaxMb` | number > 0 | — | Tamaño máximo de archivo multimedia en MB |
| `replyToMode` | `"off"` \| `"first"` \| `"all"` | — | Modo de respuesta en hilos |
| `configWrites` | boolean | `true` | Permitir escrituras de configuración desde eventos de Slack |
| `markdown` | object | — | Renderizado de tablas: `tables` puede ser `"off"`, `"bullets"` o `"code"` |
| `commands` | object | — | Opciones `native` y `nativeSkills` |

<div id="reply-to-mode-by-chat-type">

### Modo de respuesta por tipo de chat

</div>

Sobrescribir `replyToMode` por tipo de chat:

```json
{
  "connectors": {
    "slack": {
      "replyToModeByChatType": {
        "direct": "all",
        "group": "first",
        "channel": "off"
      }
    }
  }
}
```

<div id="actions">

### Acciones

</div>

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `actions.reactions` | boolean | Agregar reacciones |
| `actions.messages` | boolean | Enviar mensajes |
| `actions.pins` | boolean | Fijar mensajes |
| `actions.search` | boolean | Buscar mensajes |
| `actions.permissions` | boolean | Gestionar permisos |
| `actions.memberInfo` | boolean | Ver información de miembros |
| `actions.channelInfo` | boolean | Ver información del canal |
| `actions.emojiList` | boolean | Listar emoji disponibles |

<div id="reaction-notifications">

### Notificaciones de reacciones

</div>

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `reactionNotifications` | `"off"` \| `"own"` \| `"all"` \| `"allowlist"` | Qué reacciones activan notificaciones |
| `reactionAllowlist` | (string\|number)[] | Nombres de reacciones para notificar (al usar `"allowlist"`) |

<div id="dm-policy">

### Política de mensajes directos

</div>

| Campo | Tipo | Predeterminado | Descripción |
|-------|------|----------------|-------------|
| `dm.enabled` | boolean | — | Habilitar/deshabilitar mensajes directos |
| `dm.policy` | `"pairing"` \| `"allowlist"` \| `"open"` \| `"disabled"` | `"pairing"` | Política de acceso a mensajes directos |
| `dm.allowFrom` | (string\|number)[] | — | IDs de usuario permitidos. Debe incluir `"*"` para la política `"open"` |
| `dm.groupEnabled` | boolean | — | Habilitar mensajes directos en grupo |
| `dm.groupChannels` | (string\|number)[] | — | IDs de canales de mensajes directos en grupo permitidos |
| `dm.replyToMode` | `"off"` \| `"first"` \| `"all"` | — | Modo de respuesta en hilos específico para mensajes directos |

<div id="thread-configuration">

### Configuración de hilos

</div>

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `thread.historyScope` | `"thread"` \| `"channel"` | `"thread"` aísla el historial por hilo. `"channel"` reutiliza el historial de conversación del canal |
| `thread.inheritParent` | boolean | Si las sesiones de hilos heredan la transcripción del canal padre (predeterminado: false) |

<div id="slash-commands">

### Comandos de barra

</div>

```json
{
  "connectors": {
    "slack": {
      "slashCommand": {
        "enabled": true,
        "name": "agent",
        "sessionPrefix": "slash",
        "ephemeral": true
      }
    }
  }
}
```

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `slashCommand.enabled` | boolean | Habilitar manejo de comandos de barra |
| `slashCommand.name` | string | Nombre del comando de barra (ej., `/agent`) |
| `slashCommand.sessionPrefix` | string | Prefijo de ID de sesión para conversaciones de comandos de barra |
| `slashCommand.ephemeral` | boolean | Enviar respuestas como efímeras (visibles solo para quien invoca) |

<div id="channel-configuration">

### Configuración de canales

</div>

Configuración por canal bajo `channels.<channel-id>`:

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `enabled` | boolean | Habilitar/deshabilitar este canal |
| `allow` | boolean | Permitir el bot en este canal |
| `requireMention` | boolean | Solo responder cuando se mencione con @ |
| `tools` | ToolPolicySchema | Política de acceso a herramientas |
| `toolsBySender` | Record\<string, ToolPolicySchema\> | Políticas de herramientas por remitente |
| `allowBots` | boolean | Permitir mensajes de bots en este canal |
| `users` | (string\|number)[] | IDs de usuario permitidos |
| `skills` | string[] | Habilidades permitidas |
| `systemPrompt` | string | Prompt del sistema específico del canal |

<div id="heartbeat">

### Heartbeat

</div>

```json
{
  "connectors": {
    "slack": {
      "heartbeat": {
        "showOk": true,
        "showAlerts": true,
        "useIndicator": true
      }
    }
  }
}
```

<div id="multi-account-support">

### Soporte multi-cuenta

</div>

```json
{
  "connectors": {
    "slack": {
      "accounts": {
        "workspace-1": { "botToken": "<SLACK_BOT_TOKEN>", "appToken": "<SLACK_APP_TOKEN>" },
        "workspace-2": { "botToken": "<SLACK_BOT_TOKEN>", "appToken": "<SLACK_APP_TOKEN>" }
      }
    }
  }
}
```

<div id="related">

## Relacionado

</div>

- [Referencia del plugin de Slack](/es/plugin-registry/platform/slack)
- [Descripción general de conectores](/es/guides/connectors)
- [Referencia de configuración](/es/configuration)

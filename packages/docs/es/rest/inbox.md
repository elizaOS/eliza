---
title: "API de Bandeja de Entrada"
sidebarTitle: "Bandeja de Entrada"
description: "Endpoints de la API REST para la bandeja de entrada unificada multicanal — mensajes agregados, hilos de chat y descubrimiento de fuentes."
---

La API de bandeja de entrada proporciona una vista de solo lectura, ordenada cronológicamente, de los mensajes de todos los canales de conectores en los que participa el agente — iMessage, Telegram, Discord, WhatsApp, WeChat, Slack, Signal y SMS — fusionados en un único feed. Los mensajes del chat web del panel de control se excluyen, ya que son accesibles a través de la [API de conversaciones](/es/rest/conversations).

<div id="endpoints">

## Endpoints

</div>

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/inbox/messages` | Listar mensajes recientes de todos los canales de conectores |
| GET | `/api/inbox/chats` | Listar hilos de chat de conectores (una fila por sala) |
| GET | `/api/inbox/sources` | Listar etiquetas de fuente de conectores distintas |

---

<div id="get-apiinboxmessages">

### GET /api/inbox/messages

</div>

Lista los mensajes más recientes de todos los canales de conectores en un feed unificado, ordenado cronológicamente (los más recientes primero).

**Parámetros de consulta**

| Parámetro | Tipo | Requerido | Predeterminado | Descripción |
|-----------|------|-----------|-----------------|-------------|
| `limit` | integer | No | 100 | Máximo de mensajes a devolver (límite máximo 500) |
| `sources` | string | No | Todas las fuentes de bandeja de entrada | Filtro de fuentes separadas por comas (ej. `discord,telegram`) |
| `roomId` | string | No | — | Limitar a un único ID de sala para vistas a nivel de hilo |

**Respuesta**

```json
{
  "messages": [
    {
      "id": "uuid",
      "role": "user",
      "text": "Hey, check this out!",
      "timestamp": 1718000000000,
      "source": "discord",
      "roomId": "room-uuid",
      "from": "Alice",
      "fromUserName": "alice#1234",
      "avatarUrl": "https://cdn.discordapp.com/avatars/..."
    }
  ],
  "count": 1
}
```

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `messages[].id` | string | UUID de memoria |
| `messages[].role` | string | `user` o `assistant` |
| `messages[].text` | string | Contenido de texto del mensaje |
| `messages[].timestamp` | number | Marca de tiempo Unix (ms) de cuando se creó el mensaje |
| `messages[].source` | string | Etiqueta de fuente del conector (ej. `imessage`, `telegram`, `discord`) |
| `messages[].roomId` | string | ID de sala de chat externa para agrupación en hilos |
| `messages[].from` | string\|undefined | Nombre para mostrar del remitente (mejor esfuerzo) |
| `messages[].fromUserName` | string\|undefined | Nombre de usuario o identificador del remitente (ej. nombre de usuario de Discord) |
| `messages[].avatarUrl` | string\|undefined | URL del avatar del remitente cuando el conector lo proporciona |

Para los mensajes de Discord, `from`, `fromUserName` y `avatarUrl` se enriquecen a partir del perfil de usuario de Discord en tiempo real cuando está disponible.

---

<div id="get-apiinboxchats">

### GET /api/inbox/chats

</div>

Lista los hilos de chat de conectores — una fila por sala de chat externa. Utilizado por la barra lateral para mostrar una lista de chats unificada junto a las conversaciones del panel de control.

**Parámetros de consulta**

| Parámetro | Tipo | Requerido | Predeterminado | Descripción |
|-----------|------|-----------|-----------------|-------------|
| `sources` | string | No | Todas las fuentes de bandeja de entrada | Filtro de fuentes separadas por comas |

**Respuesta**

```json
{
  "chats": [
    {
      "id": "room-uuid",
      "source": "discord",
      "title": "#general",
      "lastMessageText": "Hey, check this out!",
      "lastMessageAt": 1718000000000,
      "messageCount": 42
    }
  ],
  "count": 1
}
```

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `chats[].id` | string | ID de sala (estable entre consultas, utilizado como clave de selección) |
| `chats[].source` | string | Etiqueta de fuente del conector para renderizado de insignias |
| `chats[].title` | string | Título para mostrar — nombre del canal, nombre del contacto para mensajes directos, o respaldo `"<source> chat"` |
| `chats[].lastMessageText` | string | Vista previa del mensaje más reciente (truncado a 140 caracteres) |
| `chats[].lastMessageAt` | number | Marca de tiempo en ms epoch del mensaje más reciente |
| `chats[].messageCount` | number | Total de mensajes en esta sala al momento del escaneo |

Los títulos de los chats se resuelven en el siguiente orden de prioridad:

1. Nombre del canal de Discord en tiempo real (obtenido del cliente de Discord para fuentes de Discord)
2. Nombre de sala almacenado (establecido por el plugin del conector cuando se creó la sala)
3. Nombre del último remitente (para salas de mensajes directos)
4. Respaldo: `"<source> chat"`

---

<div id="get-apiinboxsources">

### GET /api/inbox/sources

</div>

Lista el conjunto distinto de etiquetas de fuente de conectores para las cuales el agente actualmente tiene mensajes. Úselo para construir chips de filtro de fuente dinámicos en la interfaz sin codificar los nombres de los conectores de forma estática.

**Respuesta**

```json
{
  "sources": ["imessage", "telegram", "discord", "whatsapp"]
}
```

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `sources` | string[] | Array de etiquetas de fuente distintas presentes en el historial de mensajes del agente |

<div id="supported-sources">

## Fuentes soportadas

</div>

La bandeja de entrada incluye mensajes de estas fuentes de conectores de forma predeterminada:

| Etiqueta de fuente | Plataforma |
|---------------------|------------|
| `imessage` | iMessage |
| `telegram` | Telegram |
| `discord` | Discord |
| `whatsapp` | WhatsApp |
| `wechat` | WeChat |
| `slack` | Slack |
| `signal` | Signal |
| `sms` | SMS |

Los mensajes de `client_chat` (chat web del panel de control) y fuentes internas (eventos del sistema, ingesta de conocimiento) se excluyen del feed de la bandeja de entrada.

<div id="common-error-codes">

## Códigos de error comunes

</div>

| Estado | Código | Descripción |
|--------|--------|-------------|
| 500 | `INTERNAL_ERROR` | Error al cargar los datos de la bandeja de entrada |

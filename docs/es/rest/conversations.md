---
title: "API de Conversaciones"
sidebarTitle: "Conversaciones"
description: "Endpoints de la API REST para gestionar conversaciones de chat web — CRUD, mensajería y streaming."
---

La API de conversaciones gestiona la interfaz de chat web del agente. Cada conversación tiene su propia sala en el sistema de memoria del runtime, lo que permite historiales de mensajes independientes. La API soporta tanto la entrega de mensajes por streaming (SSE) como la entrega síncrona.

<div id="endpoints">

## Endpoints

</div>

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/conversations` | Listar todas las conversaciones |
| POST | `/api/conversations` | Crear una nueva conversación |
| GET | `/api/conversations/:id/messages` | Obtener mensajes de una conversación |
| POST | `/api/conversations/:id/messages` | Enviar un mensaje (síncrono) |
| POST | `/api/conversations/:id/messages/stream` | Enviar un mensaje (streaming SSE) |
| POST | `/api/conversations/:id/greeting` | Generar un mensaje de saludo |
| PATCH | `/api/conversations/:id` | Actualizar metadatos de la conversación |
| DELETE | `/api/conversations/:id` | Eliminar una conversación |

---

<div id="get-apiconversations">

### GET /api/conversations

</div>

Lista todas las conversaciones, ordenadas por la más recientemente actualizada primero.

**Respuesta**

```json
{
  "conversations": [
    {
      "id": "uuid",
      "title": "Morning Chat",
      "roomId": "uuid",
      "createdAt": "2025-06-01T10:00:00.000Z",
      "updatedAt": "2025-06-01T12:30:00.000Z"
    }
  ]
}
```

---

<div id="post-apiconversations">

### POST /api/conversations

</div>

Crea una nueva conversación con su propia sala.

**Cuerpo de la solicitud**

| Campo | Tipo | Requerido | Descripción |
|-------|------|-----------|-------------|
| `title` | string | No | Título de la conversación (por defecto `"New Chat"`) |

**Respuesta**

```json
{
  "conversation": {
    "id": "uuid",
    "title": "New Chat",
    "roomId": "uuid",
    "createdAt": "2025-06-01T12:00:00.000Z",
    "updatedAt": "2025-06-01T12:00:00.000Z"
  }
}
```

---

<div id="get-apiconversationsidmessages">

### GET /api/conversations/:id/messages

</div>

Recupera hasta 200 mensajes de una conversación, ordenados del más antiguo primero. Los mensajes con contenido de texto vacío (como memorias de registro de acciones) se filtran automáticamente.

**Respuesta**

```json
{
  "messages": [
    {
      "id": "uuid",
      "role": "user",
      "text": "Hello!",
      "timestamp": 1718000000000
    },
    {
      "id": "uuid",
      "role": "assistant",
      "text": "Hey there! How can I help?",
      "timestamp": 1718000001000
    },
    {
      "id": "uuid",
      "role": "user",
      "text": "What's going on in Discord?",
      "timestamp": 1718000002000,
      "source": "discord",
      "from": "Alice",
      "fromUserName": "alice#1234",
      "avatarUrl": "https://cdn.discordapp.com/avatars/..."
    }
  ]
}
```

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `messages[].role` | string | `user` o `assistant` |
| `messages[].text` | string | Contenido de texto del mensaje |
| `messages[].timestamp` | number | Marca de tiempo Unix (ms) de cuando se creó el mensaje |
| `messages[].source` | string\|undefined | Identificador de origen del conector (p. ej. `discord`, `telegram`). Se omite para mensajes de chat web |
| `messages[].from` | string\|undefined | Nombre para mostrar de la entidad emisora, cuando está disponible |
| `messages[].fromUserName` | string\|undefined | Nombre de usuario o identificador del emisor (p. ej. nombre de usuario de Discord), cuando el conector lo proporciona |
| `messages[].avatarUrl` | string\|undefined | URL del avatar del emisor cuando el conector puede proporcionarlo |

**Errores**

| Estado | Condición |
|--------|-----------|
| 404 | Conversación no encontrada |

---

<div id="post-apiconversationsidmessages">

### POST /api/conversations/:id/messages

</div>

Envía un mensaje y obtiene la respuesta del agente de forma síncrona (sin streaming).

**Cuerpo de la solicitud**

| Campo | Tipo | Requerido | Descripción |
|-------|------|-----------|-------------|
| `text` | string | Sí | Texto del mensaje del usuario |
| `channelType` | string | No | Anulación del tipo de canal |
| `images` | array | No | Datos de imágenes adjuntas |

**Respuesta**

```json
{
  "text": "Here's what I think...",
  "agentName": "Eliza"
}
```

**Errores**

| Estado | Condición |
|--------|-----------|
| 404 | Conversación no encontrada |
| 503 | El agente no está en ejecución |

---

<div id="post-apiconversationsidmessagesstream">

### POST /api/conversations/:id/messages/stream

</div>

Envía un mensaje y recibe la respuesta del agente mediante Server-Sent Events (SSE). Cada token se transmite a medida que se genera, seguido de un evento final `done`.

**Cuerpo de la solicitud**

Igual que `POST /api/conversations/:id/messages`.

**Eventos SSE**

Eventos de token (semántica de adición — cada fragmento de texto extiende la respuesta):
```
data: {"type":"token","text":"Here's"}
data: {"type":"token","text":" what"}
data: {"type":"token","text":" I think..."}
```

Eventos de instantánea (semántica de reemplazo — se usan cuando los callbacks de acciones actualizan la respuesta en su lugar):
```
data: {"type":"token","fullText":"Here's what I think...\n\nSearching for track..."}
```

Cuando un campo `fullText` está presente, es autoritativo y el cliente debe reemplazar todo el texto del mensaje del asistente en lugar de añadirlo.

Evento final:
```
data: {"type":"done","fullText":"Here's what I think...","agentName":"Eliza"}
```

El título de la conversación se genera automáticamente en segundo plano si aún es `"New Chat"`, y se emite un evento WebSocket `conversation-updated`. Si la generación de título por IA falla, el título recurre a las primeras cinco palabras del mensaje del usuario.

<Info>
Los callbacks de acciones (p. ej. de reproducción de música, flujos de billetera) usan semántica de **reemplazo**: cada callback sucesivo reemplaza la porción del callback del mensaje en lugar de añadirla. Esto coincide con el patrón de mensaje progresivo utilizado en Discord y Telegram. Consulta [Callbacks de acciones y streaming SSE](/es/runtime/action-callback-streaming) para más detalles.
</Info>

---

<div id="post-apiconversationsidgreeting">

### POST /api/conversations/:id/greeting

</div>

Genera un mensaje de saludo para una nueva conversación. Selecciona un `postExample` aleatorio de la definición de carácter del agente — sin llamada al modelo, sin latencia. El saludo se almacena como un mensaje del agente para persistencia.

**Respuesta**

```json
{
  "text": "gm. ready to go viral today or what.",
  "agentName": "Eliza",
  "generated": true
}
```

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `text` | string | El texto del saludo (vacío si no existen ejemplos de publicación) |
| `agentName` | string | Nombre para mostrar del agente |
| `generated` | boolean | `true` si había ejemplos de publicación disponibles |

---

<div id="patch-apiconversationsid">

### PATCH /api/conversations/:id

</div>

Actualiza los metadatos de la conversación (actualmente soporta renombrar).

**Cuerpo de la solicitud**

| Campo | Tipo | Requerido | Descripción |
|-------|------|-----------|-------------|
| `title` | string | No | Nuevo título de la conversación |

**Respuesta**

```json
{
  "conversation": {
    "id": "uuid",
    "title": "Updated Title",
    "roomId": "uuid",
    "createdAt": "2025-06-01T10:00:00.000Z",
    "updatedAt": "2025-06-01T14:00:00.000Z"
  }
}
```

**Errores**

| Estado | Condición |
|--------|-----------|
| 404 | Conversación no encontrada |

---

<div id="delete-apiconversationsid">

### DELETE /api/conversations/:id

</div>

Elimina una conversación. Los mensajes permanecen en la memoria del runtime, pero los metadatos de la conversación se eliminan.

**Respuesta**

```json
{
  "ok": true
}
```


<div id="common-error-codes">

## Códigos de error comunes

</div>

| Estado | Código | Descripción |
|--------|--------|-------------|
| 400 | `INVALID_REQUEST` | El cuerpo de la solicitud está malformado o le faltan campos requeridos |
| 401 | `UNAUTHORIZED` | Token de autenticación ausente o inválido |
| 404 | `NOT_FOUND` | El recurso solicitado no existe |
| 404 | `CONVERSATION_NOT_FOUND` | La conversación con el ID especificado no existe |
| 503 | `SERVICE_UNAVAILABLE` | El servicio del agente no está en ejecución actualmente |
| 500 | `INTERNAL_ERROR` | Error inesperado del servidor |

---
title: "OpenAI & Anthropic Compatible API"
sidebarTitle: "v1 Compat"
description: "OpenAI- and Anthropic-compatible REST API endpoints that allow any client built for those APIs to interact with the Milady agent."
---

Milady exposes compatibility endpoints that mirror the OpenAI and Anthropic API formats. Any client, library, or tool built for those APIs (e.g. `openai` Python SDK, `curl` scripts targeting `/v1/chat/completions`) can point at the Milady server and get agent responses. All paths are at the root (`/v1/...`) without the `/api/` prefix.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/models` | List available models (OpenAI format) |
| GET | `/v1/models/:id` | Get a single model (OpenAI format) |
| POST | `/v1/chat/completions` | Chat completion (OpenAI format) |
| POST | `/v1/messages` | Create a message (Anthropic format) |

---

### GET /v1/models

List available models in OpenAI's `/v1/models` format. Returns the agent's name and `"milady"` as model IDs.

**Response**

```json
{
  "object": "list",
  "data": [
    {
      "id": "milady",
      "object": "model",
      "created": 1718000000,
      "owned_by": "milady"
    },
    {
      "id": "Aurora",
      "object": "model",
      "created": 1718000000,
      "owned_by": "milady"
    }
  ]
}
```

---

### GET /v1/models/:id

Get details for a single model.

**Response**

```json
{
  "id": "milady",
  "object": "model",
  "created": 1718000000,
  "owned_by": "milady"
}
```

---

### POST /v1/chat/completions

OpenAI-compatible chat completions endpoint. Supports both streaming (SSE) and non-streaming modes. The `messages` array is processed to extract system and user content, which is sent to the agent for a response.

**Request Body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `messages` | array | Yes | Array of `{ role, content }` message objects |
| `model` | string | No | Model name (used in response metadata) |
| `stream` | boolean | No | Enable SSE streaming |
| `room_id` | string | No | Custom room key for conversation isolation |

```json
{
  "messages": [
    { "role": "system", "content": "You are a helpful agent." },
    { "role": "user", "content": "What is the meaning of life?" }
  ],
  "model": "milady",
  "stream": false
}
```

**Non-Streaming Response**

```json
{
  "id": "chatcmpl-uuid",
  "object": "chat.completion",
  "created": 1718000000,
  "model": "milady",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "The meaning of life is..."
      },
      "finish_reason": "stop"
    }
  ]
}
```

**Streaming Response**

When `stream: true` or the `Accept` header includes `text/event-stream`, the response uses Server-Sent Events:

```
data: {"id":"chatcmpl-uuid","object":"chat.completion.chunk","created":1718000000,"model":"milady","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}

data: {"id":"chatcmpl-uuid","object":"chat.completion.chunk","created":1718000000,"model":"milady","choices":[{"index":0,"delta":{"content":"The meaning"},"finish_reason":null}]}

data: {"id":"chatcmpl-uuid","object":"chat.completion.chunk","created":1718000000,"model":"milady","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

**Errors**

| Status | Condition |
|--------|-----------|
| 400 | `messages` array is missing or contains no user message |
| 400 | Request body contains blocked object keys |
| 503 | Agent is not running |

---

### POST /v1/messages

Anthropic-compatible Messages API endpoint. Processes the `messages` array in Anthropic format and returns the agent's response.

**Request Body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `messages` | array | Yes | Array of Anthropic-format message objects |
| `model` | string | No | Model name (used in response metadata) |
| `system` | string | No | System prompt |
| `stream` | boolean | No | Enable SSE streaming |
| `max_tokens` | number | No | Max tokens (accepted for compatibility, not enforced) |

```json
{
  "model": "milady",
  "system": "You are a helpful agent.",
  "messages": [
    {
      "role": "user",
      "content": "What is the meaning of life?"
    }
  ],
  "max_tokens": 1024
}
```

**Non-Streaming Response**

```json
{
  "id": "msg_uuid",
  "type": "message",
  "role": "assistant",
  "content": [
    {
      "type": "text",
      "text": "The meaning of life is..."
    }
  ],
  "model": "milady",
  "stop_reason": "end_turn"
}
```

**Streaming Response**

When `stream: true`, the response uses Anthropic-style SSE events:

```
event: message_start
data: {"type":"message_start","message":{"id":"msg_uuid","type":"message","role":"assistant","content":[],"model":"milady"}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"The meaning"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}

event: message_stop
data: {"type":"message_stop"}
```

**Errors**

| Status | Condition |
|--------|-----------|
| 400 | `messages` array is missing or contains no user message |
| 400 | Request body contains blocked object keys |
| 503 | Agent is not running |

---

## Usage with Standard SDKs

### OpenAI Python SDK

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:2138/v1",
    api_key="your-milady-api-token"  # or "not-needed" if no token is set
)

response = client.chat.completions.create(
    model="milady",
    messages=[{"role": "user", "content": "Hello!"}]
)
print(response.choices[0].message.content)
```

### Anthropic Python SDK

```python
import anthropic

client = anthropic.Anthropic(
    base_url="http://localhost:2138",
    api_key="your-milady-api-token"
)

message = client.messages.create(
    model="milady",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello!"}]
)
print(message.content[0].text)
```

### curl

```bash
curl http://localhost:2138/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-milady-api-token" \
  -d '{
    "model": "milady",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

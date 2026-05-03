# Supabase Edge Functions elizaOS Worker Examples

Deploy AI chat agents as serverless Supabase Edge Functions. These examples show how to run an elizaOS agent as a stateless worker that processes chat messages via HTTP.

All handlers use the full **elizaOS runtime** with OpenAI as the LLM provider, providing the same capabilities as the AWS Lambda and chat demo examples.

## Architecture

```
┌──────────────┐     ┌─────────────────┐     ┌────────────────┐
│  Test Client │────▶│  Supabase Edge  │────▶│  Edge Function │
│  (curl/deno) │◀────│  Functions      │◀────│  (elizaOS)     │
└──────────────┘     └─────────────────┘     └────────────────┘
                                                    │
                                                    ▼
                                             ┌────────────────┐
                                             │  OpenAI API    │
                                             └────────────────┘
```

## Supported Languages

| Language   | Support Level    | Notes                                    |
| ---------- | ---------------- | ---------------------------------------- |
| TypeScript | ✅ Native        | Full Deno runtime support                |
| Rust       | ✅ via WASM      | Compile to WebAssembly                   |
| Python     | ❌ Not supported | Supabase Edge Functions use Deno runtime |

> **Note**: Unlike AWS Lambda, Supabase Edge Functions run on the Deno runtime, which only natively supports TypeScript/JavaScript. Python is not supported. Rust can be used via WebAssembly compilation.

## Prerequisites

- [Supabase CLI](https://supabase.com/docs/guides/cli) installed
- [Deno](https://deno.land/) 1.40+ (for local development)
- [Rust + wasm-pack](https://rustwasm.github.io/wasm-pack/) (for Rust WASM)
- Supabase project with Edge Functions enabled
- OpenAI API key

## Quick Start

### 1. Set Environment Variables

Create a `.env` file in your Supabase project or set secrets:

```bash
# Local development
export OPENAI_API_KEY="your-openai-api-key"

# Or set in Supabase Dashboard → Project Settings → Edge Functions → Secrets
supabase secrets set OPENAI_API_KEY=your-openai-api-key
```

### 2. Initialize Supabase Project

```bash
# If starting fresh
supabase init

# Copy edge functions to your project
cp -r examples/supabase/functions/* supabase/functions/
```

### 3. Test Locally First

```bash
# Start Supabase local development
supabase start

# Serve edge functions locally
supabase functions serve eliza-chat --env-file .env

# Test with curl (in another terminal)
curl -X POST http://localhost:54321/functions/v1/eliza-chat \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_ANON_KEY" \
  -d '{"message": "Hello, Eliza!"}'
```

### 4. Deploy

```bash
# Deploy to Supabase
supabase functions deploy eliza-chat

# Set secrets (if not already set)
supabase secrets set OPENAI_API_KEY=your-openai-api-key
```

### 5. Test Your Deployment

```bash
# Get your project URL from Supabase Dashboard
curl -X POST https://YOUR_PROJECT.supabase.co/functions/v1/eliza-chat \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_ANON_KEY" \
  -d '{"message": "Hello, Eliza!"}'
```

## Project Structure

```
examples/supabase/
├── README.md                       # This file
├── functions/
│   ├── eliza-chat/                 # TypeScript Edge Function
│   │   ├── index.ts                # Main handler
│   │   ├── lib/
│   │   │   ├── runtime.ts          # elizaOS runtime manager
│   │   │   └── types.ts            # Type definitions
│   │   └── deno.json               # Deno configuration
│   └── eliza-chat-wasm/            # Rust WASM Edge Function
│       ├── index.ts                # Deno wrapper
│       └── wasm/                   # Compiled WASM module
├── rust/                           # Rust source for WASM
│   ├── Cargo.toml
│   └── src/
│       └── lib.rs
├── scripts/
│   ├── build-wasm.sh               # Build Rust to WASM
│   └── test-local.sh               # Local testing script
├── test-client.ts                  # Interactive test client
└── config.toml                     # Supabase config
```

## API Reference

### POST /functions/v1/eliza-chat

Send a message to the elizaOS agent.

**Request:**

```json
{
  "message": "Hello, how are you?",
  "userId": "optional-user-id",
  "conversationId": "optional-conversation-id"
}
```

**Response:**

```json
{
  "response": "I'm doing well, thank you for asking!",
  "conversationId": "uuid-for-conversation-tracking",
  "timestamp": "2025-01-10T12:00:00.000Z"
}
```

**Headers:**

| Header          | Required | Description                                              |
| --------------- | -------- | -------------------------------------------------------- |
| `Authorization` | Yes      | `Bearer YOUR_ANON_KEY` or `Bearer YOUR_SERVICE_ROLE_KEY` |
| `Content-Type`  | Yes      | `application/json`                                       |

### GET /functions/v1/eliza-chat/health

Health check endpoint.

**Response:**

```json
{
  "status": "healthy",
  "runtime": "elizaos-deno",
  "version": "2.0.0-alpha"
}
```

## Configuration

### Environment Variables / Secrets

| Variable             | Required | Default                   | Description         |
| -------------------- | -------- | ------------------------- | ------------------- |
| `OPENAI_API_KEY`     | Yes      | -                         | Your OpenAI API key |
| `OPENAI_SMALL_MODEL` | No       | `gpt-5-mini`              | Small model to use  |
| `OPENAI_LARGE_MODEL` | No       | `gpt-5`                   | Large model to use  |
| `CHARACTER_NAME`     | No       | `Eliza`                   | Agent's name        |
| `CHARACTER_BIO`      | No       | `A helpful AI assistant.` | Agent's bio         |
| `CHARACTER_SYSTEM`   | No       | (default)                 | System prompt       |

### Setting Secrets

```bash
# Via CLI
supabase secrets set OPENAI_API_KEY=sk-xxx CHARACTER_NAME=MyAgent

# Via Dashboard
# Project Settings → Edge Functions → Secrets
```

## TypeScript Implementation

The TypeScript implementation uses the Deno runtime natively:

```typescript
// functions/eliza-chat/index.ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handleChat, handleHealth } from "./lib/runtime.ts";

serve(async (req: Request): Promise<Response> => {
  const url = new URL(req.url);

  if (url.pathname.endsWith("/health")) {
    return handleHealth();
  }

  if (req.method === "POST") {
    return await handleChat(req);
  }

  return new Response("Method not allowed", { status: 405 });
});
```

## Rust WASM Implementation

For performance-critical operations, you can use Rust compiled to WebAssembly:

```bash
# Build WASM module
cd examples/supabase/rust
wasm-pack build --target web --out-dir ../functions/eliza-chat-wasm/wasm

# Deploy
supabase functions deploy eliza-chat-wasm
```

## Performance

### Cold Starts

Supabase Edge Functions typically have faster cold starts than traditional Lambda:

- **Cold start**: 50-200ms (vs 2-5s for Lambda)
- **Warm invocation**: 5-20ms

### Edge Locations

Edge Functions run on Deno Deploy's global edge network, providing low-latency responses worldwide.

## Monitoring

### Logs

```bash
# Stream logs
supabase functions logs eliza-chat --scroll

# Get recent logs
supabase functions logs eliza-chat
```

### Supabase Dashboard

View metrics and logs in:

- Project → Edge Functions → Select function → Logs

## Cost

Supabase Edge Functions pricing (as of 2025):

- **Free tier**: 500K invocations/month
- **Pro tier**: 2M invocations included, then $2 per 1M
- **No duration-based billing** (unlike Lambda)

## Comparison with AWS Lambda

| Feature              | Supabase Edge Functions | AWS Lambda               |
| -------------------- | ----------------------- | ------------------------ |
| Runtime              | Deno (TS/JS)            | Node, Python, Rust, etc. |
| Cold Start           | 50-200ms                | 2-5s                     |
| Global Edge          | ✅ Built-in             | Via Lambda@Edge          |
| Supabase Integration | ✅ Native               | Manual                   |
| Python Support       | ❌                      | ✅                       |
| Rust Support         | Via WASM                | Native                   |

## Troubleshooting

### "Function not found" Error

Ensure the function is deployed:

```bash
supabase functions list
supabase functions deploy eliza-chat
```

### "Unauthorized" Error

Check your authorization header:

```bash
# Get your anon key from Supabase Dashboard
curl -H "Authorization: Bearer YOUR_ANON_KEY" ...
```

### "OpenAI API key not found"

Set the secret:

```bash
supabase secrets set OPENAI_API_KEY=your-key
```

### CORS Issues

The function includes CORS headers by default. For custom domains, update the `Access-Control-Allow-Origin` header.

## Cleanup

```bash
# Delete function
supabase functions delete eliza-chat

# Remove secrets
supabase secrets unset OPENAI_API_KEY
```

## See Also

- [elizaOS Documentation](https://elizaos.ai/docs)
- [Supabase Edge Functions Docs](https://supabase.com/docs/guides/functions)
- [Deno Documentation](https://deno.land/manual)
- [AWS Lambda Example](../aws/README.md) - Same pattern for AWS




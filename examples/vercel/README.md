# Vercel Edge Function elizaOS Worker Examples

Deploy AI chat agents as serverless Vercel Edge Functions. These examples show how to run an elizaOS agent as a stateless worker that processes chat messages via HTTP.

All handlers use the full **elizaOS runtime** with OpenAI as the LLM provider, providing the same capabilities as the AWS Lambda examples.

## Architecture

```
┌──────────────┐     ┌─────────────────┐     ┌────────────────┐
│  Test Client │────▶│  Vercel Edge    │────▶│  Edge Function │
│  (curl/bun)  │◀────│  Network        │◀────│  (elizaOS)     │
└──────────────┘     └─────────────────┘     └────────────────┘
                                                    │
                                                    ▼
                                             ┌────────────────┐
                                             │  OpenAI API    │
                                             └────────────────┘
```

## Prerequisites

- [Vercel CLI](https://vercel.com/docs/cli) (`npm i -g vercel`)
- [Bun](https://bun.sh/) or [Node.js 20+](https://nodejs.org/) (for TypeScript)
- [Python 3.11+](https://www.python.org/) (for Python)
- [Rust + wasm-pack](https://rustwasm.github.io/wasm-pack/) (for Rust)
- OpenAI API key

## Quick Start

### 1. Set Environment Variables

Create a `.env` file in the project root (`/home/shaw/eliza/.env`):

```bash
OPENAI_API_KEY=your-openai-api-key
```

Or export directly:

```bash
export OPENAI_API_KEY="your-openai-api-key"
```

### 2. Test Locally First

Before deploying, test locally to verify everything works.

#### Start Local Development Server

```bash
cd examples/vercel
bun install
vercel dev
```

The development server runs at `http://localhost:3000`.

#### Run Automated Tests

```bash
# Test the local dev server
bun run test

# Or test individual runtimes
bun run test:ts     # TypeScript
bun run test:py     # Python
bun run test:rust   # Rust (local binary tests)
```

#### Test with curl

```bash
# Health check
curl http://localhost:3000/api/health

# Chat
curl -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello, Eliza!"}'
```

### 3. Deploy to Vercel

#### First-time Setup

```bash
# Link to your Vercel account
vercel link

# Set your OpenAI API key as an environment variable
vercel env add OPENAI_API_KEY
# When prompted, enter your API key
```

#### Deploy

```bash
# Preview deployment
vercel deploy

# Production deployment
vercel deploy --prod
```

### 4. Test Your Deployment

After deployment, Vercel outputs your deployment URL. Test it:

```bash
# Using curl
curl -X POST https://your-app.vercel.app/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello, Eliza!"}'

# Using the test client
bun run test-client.ts --endpoint https://your-app.vercel.app
```

## Project Structure

```
examples/vercel/
├── README.md                 # This file
├── vercel.json               # Vercel configuration
├── package.json              # Dependencies and scripts
├── tsconfig.json             # TypeScript configuration
├── test-client.ts            # Interactive test client
├── api/
│   ├── health.ts             # Health check endpoint
│   └── chat.ts               # Chat endpoint (Edge Function)
├── typescript/
│   ├── handler.ts            # Full handler (alternative structure)
│   ├── package.json
│   └── tsconfig.json
├── python/
│   ├── handler.py            # Python serverless function
│   └── requirements.txt
└── rust/
    ├── Cargo.toml
    └── src/
        ├── lib.rs            # WASM Edge Function library
        └── main.rs           # Local test runner
```

## API Reference

### POST /api/chat

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

### GET /api/health

Health check endpoint.

**Response:**

```json
{
  "status": "healthy",
  "runtime": "elizaos-typescript",
  "version": "2.0.0-alpha"
}
```

## Runtime Options

### TypeScript (Recommended)

The TypeScript version runs as a Vercel Edge Function with minimal cold start times.

```bash
# Local development
cd typescript
bun run dev

# Deploy
cd ..
vercel deploy
```

### Python

The Python version runs as a Vercel Serverless Function (not Edge, but still fast).

```bash
# Local test
cd python
python3 handler.py

# Deploy (Python functions are automatically detected)
cd ..
vercel deploy
```

### Rust (WASM)

The Rust version compiles to WebAssembly and runs on the Edge Runtime.

```bash
# Build WASM
cd rust
wasm-pack build --target web --out-dir ../api/rust/pkg

# Deploy
cd ..
vercel deploy
```

## Configuration

### Environment Variables

| Variable             | Required | Default                   | Description         |
| -------------------- | -------- | ------------------------- | ------------------- |
| `OPENAI_API_KEY`     | Yes      | -                         | Your OpenAI API key |
| `OPENAI_SMALL_MODEL` | No       | `gpt-5-mini`              | Small model to use  |
| `OPENAI_LARGE_MODEL` | No       | `gpt-5`                   | Large model to use  |
| `CHARACTER_NAME`     | No       | `Eliza`                   | Agent's name        |
| `CHARACTER_BIO`      | No       | `A helpful AI assistant.` | Agent's bio         |
| `CHARACTER_SYSTEM`   | No       | (default)                 | System prompt       |

### Character Customization

Customize the agent's personality by setting environment variables in the Vercel dashboard or CLI:

```bash
vercel env add CHARACTER_NAME
# Enter: MyBot

vercel env add CHARACTER_SYSTEM
# Enter: You are a friendly assistant that loves to help.
```

## Comparison with AWS Lambda

| Feature             | Vercel Edge    | AWS Lambda                |
| ------------------- | -------------- | ------------------------- |
| Cold start          | ~50ms          | 2-5s                      |
| Global distribution | Automatic      | Via CloudFront            |
| Pricing             | Per invocation | Per invocation + duration |
| Max execution time  | 30s (Edge)     | 15 min                    |
| Memory              | 128MB (Edge)   | Up to 10GB                |
| Languages           | JS/TS, WASM    | Many                      |

## Performance Considerations

### Edge Functions

- **Cold starts**: Edge Functions have minimal cold starts (~50ms)
- **Global distribution**: Automatically deployed to all Vercel edge locations
- **Streaming**: Supports streaming responses for real-time output

### Serverless Functions (Python)

- **Cold starts**: Slightly longer than Edge (~200-500ms)
- **Memory**: More memory available (up to 1GB)
- **Duration**: Longer execution time allowed (60s)

## Monitoring

### Vercel Dashboard

View logs, metrics, and analytics in the Vercel dashboard:

1. Go to your project at https://vercel.com
2. Click on "Functions" tab
3. View real-time logs and invocation metrics

### CLI Logs

```bash
# View production logs
vercel logs --output raw

# Follow logs in real-time
vercel logs -f
```

## Cost Estimation

Vercel pricing (as of 2025):

**Hobby (Free)**:

- 100GB bandwidth/month
- 100 hours function execution/month
- Serverless functions only

**Pro ($20/month)**:

- 1TB bandwidth/month
- 1000 hours function execution/month
- Edge functions included

**Example (10K requests/month, avg 2s response)**:

- Function hours: 10,000 × 2s = ~5.5 hours
- Well within free tier

## Troubleshooting

### "Module not found" Error

Ensure dependencies are installed:

```bash
bun install
```

### OPENAI_API_KEY Not Found

1. Verify the environment variable is set in Vercel:

   ```bash
   vercel env ls
   ```

2. If missing, add it:

   ```bash
   vercel env add OPENAI_API_KEY
   ```

3. Redeploy:
   ```bash
   vercel deploy --prod
   ```

### Function Timeout

Edge Functions have a 30-second limit. For longer operations:

1. Use Serverless Functions (60s limit)
2. Implement streaming responses
3. Consider background jobs with Vercel Cron

### CORS Issues

CORS headers are included by default. If you need custom origins:

```typescript
const headers = {
  "Access-Control-Allow-Origin": "https://your-domain.com",
  // ... other headers
};
```

## Cleanup

Remove your Vercel deployment:

```bash
# Remove from Vercel
vercel remove your-project-name

# Or delete via dashboard at vercel.com
```

## See Also

- [elizaOS Documentation](https://elizaos.ai/docs)
- [Vercel Edge Functions](https://vercel.com/docs/functions/edge-functions)
- [Vercel CLI Documentation](https://vercel.com/docs/cli)
- [AWS Lambda Examples](../aws/README.md)




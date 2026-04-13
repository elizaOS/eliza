# AWS Lambda elizaOS Worker Examples

Deploy AI chat agents as serverless AWS Lambda functions. These examples show how to run an elizaOS agent as a stateless worker that processes chat messages via HTTP.

All handlers use the full **elizaOS runtime** with OpenAI as the LLM provider, providing the same capabilities as the chat demo examples.

## Architecture

```
┌──────────────┐     ┌─────────────────┐     ┌────────────────┐
│  Test Client │────▶│  API Gateway    │────▶│  Lambda        │
│  (curl/node) │◀────│  (HTTP API)     │◀────│  (elizaOS)     │
└──────────────┘     └─────────────────┘     └────────────────┘
                                                    │
                                                    ▼
                                             ┌────────────────┐
                                             │  OpenAI API    │
                                             └────────────────┘
```

## Prerequisites

- [AWS CLI](https://aws.amazon.com/cli/) configured with credentials
- [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html)
- [Bun](https://bun.sh/) or [Node.js 20+](https://nodejs.org/) (for TypeScript)
- [Python 3.11+](https://www.python.org/) (for Python)
- [Rust + Cargo Lambda](https://www.cargo-lambda.info/) (for Rust)
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
export AWS_REGION="us-east-1"  # or your preferred region
```

### 2. Test Locally First

Before deploying, test locally to verify everything works. Each language has a self-contained test that loads the `.env` file from the project root automatically:

#### TypeScript

```bash
cd examples/aws/typescript
bun run test:full                # Run automated tests with elizaOS runtime
bun run start                    # Start local HTTP server on port 3000
```

#### Python

```bash
cd examples/aws/python
pip install -e ../../../packages/python -e ../../../plugins/plugin-openai/python
python3 handler.py               # Runs automated tests with elizaOS runtime
```

#### Rust

```bash
cd examples/aws/rust
cargo run --bin test_local       # Run automated tests with elizaOS runtime
```

#### Test the Local Server (TypeScript)

```bash
# In another terminal, test the API
curl -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello!"}'
```

### 3. Deploy (Choose Your Language)

#### TypeScript

```bash
cd examples/aws/typescript
bun run build
sam deploy --guided --parameter-overrides OpenAIApiKey=$OPENAI_API_KEY
```

#### Python

```bash
cd examples/aws/python
sam deploy --guided --parameter-overrides RuntimeLanguage=python OpenAIApiKey=$OPENAI_API_KEY
```

#### Rust

```bash
cd examples/aws/rust
cargo lambda build --release
sam deploy --guided --parameter-overrides RuntimeLanguage=rust OpenAIApiKey=$OPENAI_API_KEY
```

### 4. Test Your Deployment

After deployment, SAM outputs your API endpoint URL. Test it:

```bash
# Using curl
curl -X POST https://YOUR_API_ID.execute-api.us-east-1.amazonaws.com/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello, Eliza!"}'

# Using the test client
cd examples/aws
npm install
npx ts-node test-client.ts --endpoint https://YOUR_API_ID.execute-api.us-east-1.amazonaws.com/chat
```

## Project Structure

```
examples/aws/
├── README.md                 # This file
├── template.yaml             # SAM template (shared infrastructure)
├── test-client.ts            # Interactive test client
├── package.json              # Test client dependencies
├── typescript/
│   ├── handler.ts            # Lambda handler (elizaOS runtime)
│   ├── package.json
│   └── tsconfig.json
├── python/
│   ├── handler.py            # Lambda handler (elizaOS runtime)
│   └── requirements.txt
└── rust/
    ├── Cargo.toml
    └── src/
        ├── lib.rs            # Lambda handler library (elizaOS runtime)
        ├── main.rs           # Lambda entry point
        └── test_local.rs     # Local test runner
```

## API Reference

### POST /chat

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

### GET /health

Health check endpoint.

**Response:**

```json
{
  "status": "healthy",
  "runtime": "elizaos-typescript|elizaos-python|elizaos-rust",
  "version": "2.0.0-alpha"
}
```

## Deployment Options

### Option 1: SAM CLI (Recommended)

```bash
# First-time deployment with guided prompts
sam deploy --guided

# Subsequent deployments
sam deploy
```

### Option 2: CloudFormation

```bash
aws cloudformation deploy \
  --template-file template.yaml \
  --stack-name eliza-worker \
  --parameter-overrides OpenAIApiKey=$OPENAI_API_KEY \
  --capabilities CAPABILITY_IAM
```

### Option 3: Terraform

See `terraform/` directory for Terraform configuration.

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
| `LOG_LEVEL`          | No       | `INFO`                    | Logging level       |

### Character Customization

You can customize the agent's personality by setting environment variables or modifying the character definition in the handler:

```typescript
const character: Character = {
  name: process.env.CHARACTER_NAME ?? "Eliza",
  bio: process.env.CHARACTER_BIO ?? "A helpful AI assistant.",
  system: process.env.CHARACTER_SYSTEM ?? "You are helpful and concise.",
};
```

## Performance Considerations

### Cold Starts

Lambda cold starts can take 2-5 seconds due to runtime initialization. To minimize:

1. **Provisioned Concurrency**: Keep instances warm

   ```yaml
   ProvisionedConcurrencyConfig:
     ProvisionedConcurrentExecutions: 1
   ```

2. **SnapStart** (Java only): Not applicable for these runtimes

3. **Smaller Package**: Use tree-shaking and minimal dependencies

### Memory Configuration

Recommended memory settings:

| Runtime    | Memory | Timeout |
| ---------- | ------ | ------- |
| TypeScript | 512 MB | 30s     |
| Python     | 512 MB | 30s     |
| Rust       | 256 MB | 30s     |

## Monitoring

### CloudWatch Logs

Lambda automatically logs to CloudWatch. View logs:

```bash
sam logs -n ElizaWorkerFunction --stack-name eliza-worker --tail
```

### CloudWatch Metrics

Key metrics to monitor:

- Invocations
- Duration
- Errors
- Throttles
- ConcurrentExecutions

## Cost Estimation

AWS Lambda pricing (as of 2025):

- **Requests**: $0.20 per 1M requests
- **Duration**: $0.0000166667 per GB-second

Example (512 MB, 2s avg duration, 10K requests/month):

- Requests: $0.002
- Duration: 10,000 × 2s × 0.5GB × $0.0000166667 = $0.17
- **Total: ~$0.20/month**

## Troubleshooting

### "Module not found" Error

Ensure all dependencies are bundled:

```bash
# TypeScript
bun run build

# Python
pip install -r requirements.txt -t ./

# Rust
cargo lambda build --release
```

### Timeout Errors

Increase timeout in `template.yaml`:

```yaml
Timeout: 60 # seconds
```

### API Key Not Found

Verify the environment variable is set:

```bash
sam deploy --parameter-overrides OpenAIApiKey=$OPENAI_API_KEY
```

## Cleanup

Remove all deployed resources:

```bash
sam delete --stack-name eliza-worker
```

## See Also

- [elizaOS Documentation](https://elizaos.ai/docs)
- [AWS Lambda Documentation](https://docs.aws.amazon.com/lambda/)
- [SAM CLI Documentation](https://docs.aws.amazon.com/serverless-application-model/)

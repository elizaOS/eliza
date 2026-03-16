# GCP Cloud Run elizaOS Worker Examples

Deploy elizaOS agents as serverless GCP Cloud Run services. This example shows how to run an AI agent as a containerized worker that processes chat messages via HTTP.

## Architecture

```
┌──────────────┐     ┌─────────────────┐     ┌────────────────┐
│  Test Client │────▶│  Cloud Run      │────▶│  elizaOS       │
│  (curl/node) │◀────│  (HTTP)         │◀────│  Worker        │
└──────────────┘     └─────────────────┘     └────────────────┘
                                                     │
                                                     ▼
                                              ┌────────────────┐
                                              │  OpenAI API    │
                                              └────────────────┘
```

## Prerequisites

- [Google Cloud SDK](https://cloud.google.com/sdk/docs/install) installed and configured
- [Docker](https://docs.docker.com/get-docker/) installed
- GCP project with Cloud Run API enabled
- OpenAI API key

## Quick Start

### 1. Set Environment Variables

```bash
export PROJECT_ID="your-gcp-project-id"
export REGION="us-central1"
export OPENAI_API_KEY="your-openai-api-key"
```

### 2. Enable Required APIs

```bash
gcloud config set project $PROJECT_ID
gcloud services enable run.googleapis.com
gcloud services enable cloudbuild.googleapis.com
gcloud services enable artifactregistry.googleapis.com
```

### 3. Deploy (Choose Your Language)

#### TypeScript

```bash
cd examples/gcp/typescript
npm install
npm run build

# Build and deploy
gcloud run deploy eliza-worker-ts \
  --source . \
  --region $REGION \
  --allow-unauthenticated \
  --set-env-vars "OPENAI_API_KEY=$OPENAI_API_KEY"
```

#### Python

```bash
cd examples/gcp/python

# Build and deploy
gcloud run deploy eliza-worker-py \
  --source . \
  --region $REGION \
  --allow-unauthenticated \
  --set-env-vars "OPENAI_API_KEY=$OPENAI_API_KEY"
```

#### Rust

```bash
cd examples/gcp/rust

# Build container
docker build -t eliza-worker-rust .

# Tag and push to Artifact Registry
docker tag eliza-worker-rust $REGION-docker.pkg.dev/$PROJECT_ID/eliza/eliza-worker-rust
docker push $REGION-docker.pkg.dev/$PROJECT_ID/eliza/eliza-worker-rust

# Deploy
gcloud run deploy eliza-worker-rust \
  --image $REGION-docker.pkg.dev/$PROJECT_ID/eliza/eliza-worker-rust \
  --region $REGION \
  --allow-unauthenticated \
  --set-env-vars "OPENAI_API_KEY=$OPENAI_API_KEY"
```

### 4. Test Your Deployment

After deployment, Cloud Run provides a URL. Test it:

```bash
# Get service URL
SERVICE_URL=$(gcloud run services describe eliza-worker-ts --region $REGION --format 'value(status.url)')

# Health check
curl $SERVICE_URL/health

# Chat
curl -X POST $SERVICE_URL/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello, Eliza!"}'

# Using the test client
cd examples/gcp
bun run test-client.ts --url $SERVICE_URL
```

## Local Development

### TypeScript

```bash
cd examples/gcp/typescript
npm install
npm run dev
# Server runs at http://localhost:8080
```

### Python

```bash
cd examples/gcp/python
pip install -r requirements.txt
python handler.py
# Server runs at http://localhost:8080
```

### Rust

```bash
cd examples/gcp/rust
cargo run
# Server runs at http://localhost:8080
```

## Project Structure

```
examples/gcp/
├── README.md                 # This file
├── test-client.ts            # Interactive test client
├── package.json              # Test client dependencies
├── cloudbuild.yaml           # Cloud Build configuration
├── typescript/
│   ├── handler.ts            # Cloud Run handler
│   ├── Dockerfile
│   ├── package.json
│   └── tsconfig.json
├── python/
│   ├── handler.py            # Cloud Run handler
│   ├── Dockerfile
│   └── requirements.txt
└── rust/
    ├── Cargo.toml
    ├── Dockerfile
    └── src/
        └── main.rs           # Cloud Run handler
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
  "runtime": "typescript|python|rust",
  "version": "2.0.0-alpha"
}
```

### GET /

Service info endpoint.

**Response:**

```json
{
  "name": "Eliza",
  "bio": "A helpful AI assistant.",
  "version": "2.0.0-alpha",
  "powered_by": "elizaOS"
}
```

## Deployment Options

### Option 1: gcloud run deploy (Recommended)

```bash
# Deploy from source (builds automatically)
gcloud run deploy eliza-worker \
  --source . \
  --region $REGION \
  --allow-unauthenticated \
  --set-env-vars "OPENAI_API_KEY=$OPENAI_API_KEY"
```

### Option 2: Cloud Build

```bash
# Submit build and deploy
gcloud builds submit --config=cloudbuild.yaml \
  --substitutions=_REGION=$REGION,_OPENAI_API_KEY=$OPENAI_API_KEY
```

### Option 3: Terraform

See the [Terraform example](./terraform/) for infrastructure-as-code deployment.

## Configuration

### Environment Variables

| Variable           | Required | Default                   | Description                    |
| ------------------ | -------- | ------------------------- | ------------------------------ |
| `OPENAI_API_KEY`   | Yes      | -                         | Your OpenAI API key            |
| `OPENAI_MODEL`     | No       | `gpt-5-mini`              | Model to use                   |
| `OPENAI_BASE_URL`  | No       | OpenAI default            | Custom API endpoint            |
| `CHARACTER_NAME`   | No       | `Eliza`                   | Agent's name                   |
| `CHARACTER_BIO`    | No       | `A helpful AI assistant.` | Agent's bio                    |
| `CHARACTER_SYSTEM` | No       | Default system prompt     | Custom system prompt           |
| `PORT`             | No       | `8080`                    | Server port (set by Cloud Run) |
| `LOG_LEVEL`        | No       | `INFO`                    | Logging level                  |

### Character Customization

Customize the agent's personality via environment variables:

```bash
gcloud run deploy eliza-worker \
  --set-env-vars "OPENAI_API_KEY=$OPENAI_API_KEY" \
  --set-env-vars "CHARACTER_NAME=Ada" \
  --set-env-vars "CHARACTER_BIO=A brilliant mathematician and programmer" \
  --set-env-vars "CHARACTER_SYSTEM=You are Ada Lovelace, speaking from the 19th century..."
```

## Performance Considerations

### Cold Starts

Cloud Run cold starts are typically 1-3 seconds. To minimize:

1. **Minimum Instances**: Keep at least one instance warm

   ```bash
   gcloud run deploy eliza-worker --min-instances 1
   ```

2. **Smaller Container**: Use multi-stage Docker builds

3. **Startup CPU Boost**: Enable for faster cold starts
   ```bash
   gcloud run deploy eliza-worker --cpu-boost
   ```

### Resource Configuration

Recommended settings:

| Runtime    | Memory | CPU | Timeout |
| ---------- | ------ | --- | ------- |
| TypeScript | 512 Mi | 1   | 60s     |
| Python     | 512 Mi | 1   | 60s     |
| Rust       | 256 Mi | 1   | 60s     |

```bash
gcloud run deploy eliza-worker \
  --memory 512Mi \
  --cpu 1 \
  --timeout 60s
```

## Monitoring

### View Logs

```bash
gcloud run logs read eliza-worker --region $REGION --limit 100
```

### Streaming Logs

```bash
gcloud run logs tail eliza-worker --region $REGION
```

### Cloud Monitoring

Cloud Run automatically provides metrics:

- Request count
- Request latencies
- Container instance count
- Billable container instance time
- CPU and memory utilization

## Cost Estimation

Cloud Run pricing (as of 2025):

- **CPU**: $0.000024 per vCPU-second
- **Memory**: $0.0000025 per GiB-second
- **Requests**: $0.40 per million requests

Example (1 vCPU, 512 MiB, 2s avg duration, 10K requests/month):

- CPU: 10,000 × 2s × $0.000024 = $0.48
- Memory: 10,000 × 2s × 0.5 × $0.0000025 = $0.025
- Requests: 10,000 × $0.0000004 = $0.004
- **Total: ~$0.51/month**

_Note: Free tier includes 2 million requests/month_

## Authentication

### Allow Unauthenticated (Public)

```bash
gcloud run deploy eliza-worker --allow-unauthenticated
```

### Require Authentication

```bash
gcloud run deploy eliza-worker --no-allow-unauthenticated

# Invoke with authentication
curl -H "Authorization: Bearer $(gcloud auth print-identity-token)" \
  $SERVICE_URL/chat
```

### Custom Domain

```bash
gcloud run domain-mappings create \
  --service eliza-worker \
  --domain eliza.yourdomain.com \
  --region $REGION
```

## Troubleshooting

### Container Fails to Start

Check logs for startup errors:

```bash
gcloud run logs read eliza-worker --region $REGION --limit 50
```

### "Permission Denied" Error

Ensure the service account has required permissions:

```bash
gcloud run services add-iam-policy-binding eliza-worker \
  --member="allUsers" \
  --role="roles/run.invoker" \
  --region $REGION
```

### API Key Not Found

Verify environment variables are set:

```bash
gcloud run services describe eliza-worker \
  --region $REGION \
  --format 'yaml(spec.template.spec.containers[0].env)'
```

### Timeout Errors

Increase request timeout:

```bash
gcloud run deploy eliza-worker --timeout 300s
```

## Cleanup

Remove all deployed resources:

```bash
# Delete Cloud Run service
gcloud run services delete eliza-worker --region $REGION --quiet

# Delete container images (optional)
gcloud artifacts docker images delete \
  $REGION-docker.pkg.dev/$PROJECT_ID/eliza/eliza-worker --quiet
```

## Security Best Practices

1. **Use Secret Manager** for API keys:

   ```bash
   echo -n "$OPENAI_API_KEY" | gcloud secrets create openai-api-key --data-file=-

   gcloud run deploy eliza-worker \
     --set-secrets "OPENAI_API_KEY=openai-api-key:latest"
   ```

2. **Enable VPC Connector** for private networking

3. **Set up Cloud Armor** for DDoS protection

4. **Use IAM** for authentication when possible

## See Also

- [elizaOS Documentation](https://elizaos.ai/docs)
- [Cloud Run Documentation](https://cloud.google.com/run/docs)
- [Cloud Build Documentation](https://cloud.google.com/build/docs)
- [Artifact Registry Documentation](https://cloud.google.com/artifact-registry/docs)

# Jobs API - One-Off Agent Messaging

The Jobs API provides a simple, one-off messaging pattern similar to `@bankr/sdk`. It's perfect for:
- Single question/response interactions
- Stateless API integrations
- Quick agent queries without session management
- Integration with external systems

## Overview

Unlike the Sessions API which manages persistent conversations, the Jobs API is designed for one-time interactions:

1. **Create a job** - Send a message to an agent
2. **Poll for completion** - Check the job status until complete
3. **Get the response** - Retrieve the agent's reply

## API Endpoints

### 1. Create a Job

**Endpoint:** `POST /api/messaging/jobs`

**Authentication:** JWT Token or API Key required

**Request Body:**
```json
{
  "agentId": "uuid",     // Optional - uses first available agent if not provided
  "userId": "uuid", 
  "content": "Your message/prompt here",
  "metadata": {},        // Optional
  "timeoutMs": 30000     // Optional, default: 30000, max: 300000
}
```

**Response:**
```json
{
  "jobId": "uuid",
  "status": "processing",
  "createdAt": 1234567890,
  "expiresAt": 1234597890
}
```

### 2. Get Job Status

**Endpoint:** `GET /api/messaging/jobs/:jobId`

**Authentication:** Not required for status check

**Response (Processing):**
```json
{
  "jobId": "uuid",
  "status": "processing",
  "agentId": "uuid",
  "userId": "uuid",
  "prompt": "Your original message",
  "createdAt": 1234567890,
  "expiresAt": 1234597890
}
```

**Response (Completed):**
```json
{
  "jobId": "uuid",
  "status": "completed",
  "agentId": "uuid",
  "userId": "uuid",
  "prompt": "Your original message",
  "createdAt": 1234567890,
  "expiresAt": 1234597890,
  "result": {
    "message": {
      "id": "uuid",
      "content": "Agent's response here",
      "authorId": "uuid",
      "createdAt": 1234568000,
      "metadata": {}
    },
    "processingTimeMs": 1500
  }
}
```

**Response (Failed/Timeout):**
```json
{
  "jobId": "uuid",
  "status": "failed",
  "agentId": "uuid",
  "userId": "uuid",
  "prompt": "Your original message",
  "createdAt": 1234567890,
  "expiresAt": 1234597890,
  "error": "Error message here"
}
```

### 3. List Jobs (Admin)

**Endpoint:** `GET /api/messaging/jobs?limit=50&status=completed`

**Authentication:** JWT Token or API Key required

**Query Parameters:**
- `limit` - Number of jobs to return (default: 50)
- `status` - Filter by status: pending, processing, completed, failed, timeout

**Response:**
```json
{
  "jobs": [...],
  "total": 100,
  "filtered": 50
}
```

### 4. Health Check

**Endpoint:** `GET /api/messaging/jobs/health`

**Response:**
```json
{
  "healthy": true,
  "timestamp": 1234567890,
  "totalJobs": 42,
  "statusCounts": {
    "pending": 0,
    "processing": 5,
    "completed": 30,
    "failed": 2,
    "timeout": 5
  },
  "maxJobs": 10000
}
```

## Job Status

| Status | Description |
|--------|-------------|
| `pending` | Job created, waiting to be processed |
| `processing` | Agent is processing the message |
| `completed` | Agent has responded successfully |
| `failed` | Job failed due to an error |
| `timeout` | Job exceeded the timeout period |

## Usage Examples

### Example 1: Basic Usage with cURL

```bash
# 1. Create a job (agentId is optional - will use first agent if not provided)
JOB_RESPONSE=$(curl -X POST http://localhost:3000/api/messaging/jobs \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-api-key" \
  -d '{
    "userId": "user-uuid",
    "content": "What is the current Bitcoin price?"
  }')

JOB_ID=$(echo $JOB_RESPONSE | jq -r '.jobId')

# 2. Poll for completion (with retry)
for i in {1..30}; do
  STATUS=$(curl -s http://localhost:3000/api/messaging/jobs/$JOB_ID \
    -H "x-api-key: your-api-key")
  
  if echo $STATUS | jq -e '.status == "completed"' > /dev/null; then
    echo "Response: $(echo $STATUS | jq -r '.result.message.content')"
    break
  fi
  
  sleep 1
done
```

### Example 2: JavaScript/TypeScript

```typescript
// Simple polling function
async function sendJobAndWait(agentId: string, userId: string, content: string) {
  // Create job
  const createRes = await fetch('http://localhost:3000/api/messaging/jobs', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': 'your-api-key'
    },
    body: JSON.stringify({ agentId, userId, content })
  });
  
  const { jobId } = await createRes.json();
  
  // Poll for completion
  for (let i = 0; i < 30; i++) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    const statusRes = await fetch(`http://localhost:3000/api/messaging/jobs/${jobId}`, {
      headers: { 'x-api-key': 'your-api-key' }
    });
    
    const status = await statusRes.json();
    
    if (status.status === 'completed') {
      return status.result.message.content;
    } else if (status.status === 'failed' || status.status === 'timeout') {
      throw new Error(status.error);
    }
  }
  
  throw new Error('Timeout waiting for response');
}

// Usage
const response = await sendJobAndWait(
  'agent-uuid',
  'user-uuid', 
  'What are the top DeFi protocols?'
);
console.log(response);
```

### Example 3: SDK-Style Client

See `/examples/jobs-api-example.ts` for a complete SDK-style client implementation similar to `@bankr/sdk`.

## Comparison with Sessions API

| Feature | Jobs API | Sessions API |
|---------|----------|--------------|
| **Use Case** | One-off queries | Persistent conversations |
| **State** | Stateless | Stateful |
| **Message History** | Single message | Full conversation |
| **Timeout** | Per job | Per session (with auto-renewal) |
| **Cleanup** | Automatic | Automatic on expiry |
| **Complexity** | Simple | More complex |
| **Real-time** | Polling required | Polling or SocketIO |

## Best Practices

1. **Set appropriate timeouts** - Default is 30s, but complex queries may need longer
2. **Implement exponential backoff** - Start with 1s polling, increase if needed
3. **Handle all status types** - Check for completed, failed, and timeout
4. **Clean up on client side** - Don't keep polling forever
5. **Use API keys for server-to-server** - JWT for user-facing apps

## Configuration

Environment variables:
- `SESSION_CLEANUP_INTERVAL_MINUTES` - How often to clean up expired jobs (default: 5 minutes)

## Limitations

- Max 10,000 jobs in memory (oldest are auto-cleaned)
- Max timeout: 5 minutes per job
- Jobs auto-expire after completion + timeout period
- No message history (single message/response only)

## Security

- Jobs require authentication to create
- Job status is publicly readable (design choice for simplicity)
- Consider implementing job ownership checks if needed
- Rate limiting applies to job creation

## Monitoring

Use the health endpoint to monitor:
- Total active jobs
- Jobs by status
- System capacity (current/max)

## Migration from @bankr/sdk

If you're coming from `@bankr/sdk`:

| @bankr/sdk | Eliza Jobs API |
|------------|----------------|
| `client.prompt()` | `POST /api/messaging/jobs` |
| `client.poll()` | `GET /api/messaging/jobs/:jobId` (with retry logic) |
| `jobId` | Same - `jobId` |
| Transaction types | Use `metadata` field |
| XMTP integration | Not built-in (can be added) |

## Future Enhancements

Potential additions:
- WebSocket support for real-time updates
- Batch job creation
- Job cancellation
- XMTP integration
- Rich data types (charts, cards, etc.)
- Job prioritization


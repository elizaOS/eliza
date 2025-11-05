# Jobs API - Usage Examples

## Example 1: Minimal Request (No Agent ID)

The simplest way to use the Jobs API - just provide your message:

```bash
curl -X POST http://localhost:3000/api/messaging/jobs \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "user-uuid",
    "content": "What is the weather today?"
  }'
```

**Response:**
```json
{
  "jobId": "abc123...",
  "status": "processing",
  "createdAt": 1234567890,
  "expiresAt": 1234597890
}
```

The server will automatically use the first available agent.

## Example 2: With Specific Agent

If you want to target a specific agent:

```bash
curl -X POST http://localhost:3000/api/messaging/jobs \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "specific-agent-uuid",
    "userId": "user-uuid",
    "content": "Analyze the DeFi market"
  }'
```

## Example 3: With Metadata and Timeout

```bash
curl -X POST http://localhost:3000/api/messaging/jobs \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "user-uuid",
    "content": "Complex analysis query",
    "metadata": {
      "source": "mobile-app",
      "version": "1.0.0"
    },
    "timeoutMs": 60000
  }'
```

## Example 4: Poll Until Complete (Shell Script)

```bash
#!/bin/bash

# Create job
RESPONSE=$(curl -s -X POST http://localhost:3000/api/messaging/jobs \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "user-uuid",
    "content": "What is Bitcoin price?"
  }')

JOB_ID=$(echo $RESPONSE | jq -r '.jobId')
echo "Created job: $JOB_ID"

# Poll for completion
for i in {1..30}; do
  STATUS=$(curl -s http://localhost:3000/api/messaging/jobs/$JOB_ID)
  STATE=$(echo $STATUS | jq -r '.status')
  
  echo "[$i] Status: $STATE"
  
  if [ "$STATE" = "completed" ]; then
    echo "Response: $(echo $STATUS | jq -r '.result.message.content')"
    exit 0
  elif [ "$STATE" = "failed" ] || [ "$STATE" = "timeout" ]; then
    echo "Error: $(echo $STATUS | jq -r '.error')"
    exit 1
  fi
  
  sleep 1
done

echo "Timeout waiting for response"
exit 1
```

## Example 5: JavaScript/Node.js

```javascript
async function askAgent(content, userId = 'default-user-uuid') {
  // Create job
  const createRes = await fetch('http://localhost:3000/api/messaging/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, content })
  });
  
  const { jobId } = await createRes.json();
  console.log('Job created:', jobId);
  
  // Poll for result
  for (let i = 0; i < 30; i++) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    const statusRes = await fetch(`http://localhost:3000/api/messaging/jobs/${jobId}`);
    const status = await statusRes.json();
    
    if (status.status === 'completed') {
      return status.result.message.content;
    } else if (status.status === 'failed' || status.status === 'timeout') {
      throw new Error(status.error);
    }
  }
  
  throw new Error('Polling timeout');
}

// Usage
askAgent('What is the DeFi TVL?')
  .then(response => console.log('Agent:', response))
  .catch(err => console.error('Error:', err));
```

## Example 6: Python

```python
import requests
import time
import json

def ask_agent(content, user_id='default-user-uuid', agent_id=None):
    # Create job
    payload = {
        'userId': user_id,
        'content': content
    }
    if agent_id:
        payload['agentId'] = agent_id
    
    response = requests.post(
        'http://localhost:3000/api/messaging/jobs',
        json=payload
    )
    job = response.json()
    job_id = job['jobId']
    print(f'Job created: {job_id}')
    
    # Poll for result
    for attempt in range(30):
        time.sleep(1)
        
        status = requests.get(
            f'http://localhost:3000/api/messaging/jobs/{job_id}'
        ).json()
        
        if status['status'] == 'completed':
            return status['result']['message']['content']
        elif status['status'] in ['failed', 'timeout']:
            raise Exception(status.get('error', 'Job failed'))
    
    raise Exception('Polling timeout')

# Usage
try:
    response = ask_agent('What is Bitcoin price?')
    print(f'Agent: {response}')
except Exception as e:
    print(f'Error: {e}')
```

## Example 7: TypeScript with Retry Logic

```typescript
interface JobResponse {
  jobId: string;
  status: string;
  result?: {
    message: {
      content: string;
      processingTimeMs: number;
    };
  };
  error?: string;
}

async function askAgentWithRetry(
  content: string,
  userId: string,
  options: {
    agentId?: string;
    maxAttempts?: number;
    pollInterval?: number;
    timeout?: number;
  } = {}
): Promise<string> {
  const {
    agentId,
    maxAttempts = 30,
    pollInterval = 1000,
    timeout = 30000,
  } = options;

  // Create job
  const createRes = await fetch('http://localhost:3000/api/messaging/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId,
      content,
      ...(agentId && { agentId }),
      timeoutMs: timeout,
    }),
  });

  if (!createRes.ok) {
    throw new Error(`Failed to create job: ${createRes.statusText}`);
  }

  const { jobId } = await createRes.json();
  const startTime = Date.now();

  // Poll for result with timeout
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Check overall timeout
    if (Date.now() - startTime > timeout) {
      throw new Error('Overall timeout exceeded');
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval));

    const statusRes = await fetch(
      `http://localhost:3000/api/messaging/jobs/${jobId}`
    );
    const status: JobResponse = await statusRes.json();

    if (status.status === 'completed') {
      return status.result!.message.content;
    } else if (status.status === 'failed' || status.status === 'timeout') {
      throw new Error(status.error || 'Job failed');
    }
  }

  throw new Error('Max polling attempts exceeded');
}

// Usage
askAgentWithRetry('Explain Uniswap V3', 'user-uuid', {
  pollInterval: 1000,
  maxAttempts: 60,
  timeout: 60000,
})
  .then((response) => console.log('Agent:', response))
  .catch((err) => console.error('Error:', err));
```

## Example 8: Batch Questions

```javascript
async function askMultipleQuestions(questions, userId) {
  const jobIds = [];
  
  // Create all jobs
  for (const question of questions) {
    const res = await fetch('http://localhost:3000/api/messaging/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, content: question })
    });
    const { jobId } = await res.json();
    jobIds.push({ jobId, question });
  }
  
  // Poll all jobs
  const results = [];
  for (const { jobId, question } of jobIds) {
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 1000));
      
      const status = await fetch(
        `http://localhost:3000/api/messaging/jobs/${jobId}`
      ).then(r => r.json());
      
      if (status.status === 'completed') {
        results.push({
          question,
          answer: status.result.message.content
        });
        break;
      }
    }
  }
  
  return results;
}

// Usage
const questions = [
  'What is Bitcoin price?',
  'What is Ethereum price?',
  'What is the total DeFi TVL?'
];

askMultipleQuestions(questions, 'user-uuid')
  .then(results => console.log(results));
```

## Example 9: Error Handling

```javascript
async function robustAskAgent(content, userId) {
  try {
    // Create job
    const createRes = await fetch('http://localhost:3000/api/messaging/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, content })
    });
    
    if (!createRes.ok) {
      const error = await createRes.json();
      throw new Error(error.error || 'Failed to create job');
    }
    
    const { jobId } = await createRes.json();
    
    // Poll with exponential backoff
    let interval = 500; // Start with 500ms
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, interval));
      
      const statusRes = await fetch(
        `http://localhost:3000/api/messaging/jobs/${jobId}`
      );
      
      if (!statusRes.ok) {
        throw new Error('Failed to fetch job status');
      }
      
      const status = await statusRes.json();
      
      if (status.status === 'completed') {
        return {
          success: true,
          content: status.result.message.content,
          processingTime: status.result.processingTimeMs
        };
      } else if (status.status === 'failed') {
        return {
          success: false,
          error: status.error
        };
      } else if (status.status === 'timeout') {
        return {
          success: false,
          error: 'Job timed out waiting for agent response'
        };
      }
      
      // Exponential backoff (up to 5 seconds)
      interval = Math.min(interval * 1.5, 5000);
    }
    
    return {
      success: false,
      error: 'Polling timeout exceeded'
    };
    
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

// Usage with error handling
const result = await robustAskAgent('What is DeFi?', 'user-uuid');
if (result.success) {
  console.log('Response:', result.content);
  console.log('Processing time:', result.processingTime, 'ms');
} else {
  console.error('Failed:', result.error);
}
```

## Example 10: React Hook

```typescript
import { useState, useCallback } from 'react';

function useJobsAPI(userId: string) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const askAgent = useCallback(
    async (content: string, agentId?: string) => {
      setLoading(true);
      setError(null);

      try {
        // Create job
        const createRes = await fetch('http://localhost:3000/api/messaging/jobs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId, content, agentId }),
        });

        const { jobId } = await createRes.json();

        // Poll for result
        for (let i = 0; i < 30; i++) {
          await new Promise((r) => setTimeout(r, 1000));

          const statusRes = await fetch(
            `http://localhost:3000/api/messaging/jobs/${jobId}`
          );
          const status = await statusRes.json();

          if (status.status === 'completed') {
            setLoading(false);
            return status.result.message.content;
          } else if (status.status === 'failed' || status.status === 'timeout') {
            throw new Error(status.error);
          }
        }

        throw new Error('Polling timeout');
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        setError(message);
        setLoading(false);
        throw err;
      }
    },
    [userId]
  );

  return { askAgent, loading, error };
}

// Usage in component
function ChatComponent({ userId }: { userId: string }) {
  const { askAgent, loading, error } = useJobsAPI(userId);
  const [response, setResponse] = useState('');

  const handleAsk = async () => {
    try {
      const answer = await askAgent('What is Bitcoin?');
      setResponse(answer);
    } catch (err) {
      console.error('Failed to get response');
    }
  };

  return (
    <div>
      <button onClick={handleAsk} disabled={loading}>
        {loading ? 'Asking...' : 'Ask Agent'}
      </button>
      {error && <div>Error: {error}</div>}
      {response && <div>Agent: {response}</div>}
    </div>
  );
}
```


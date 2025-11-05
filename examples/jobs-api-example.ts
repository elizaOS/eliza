/**
 * Example: Using the Jobs API for one-off agent messaging
 */

// Example 1: Simple job creation and polling
async function simpleJobExample() {
  const API_URL = 'http://localhost:3000/api/messaging';
  const API_KEY = 'your-api-key';

  // 1. Create a job (send a one-off message to an agent)
  const createResponse = await fetch(`${API_URL}/jobs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
    },
    body: JSON.stringify({
      agentId: 'your-agent-uuid',
      userId: 'your-user-uuid',
      content: 'What is the current market status for Bitcoin?',
      metadata: {
        source: 'api-example',
      },
      timeoutMs: 30000, // 30 seconds timeout
    }),
  });

  const jobData = await createResponse.json();
  console.log('Job created:', jobData);
  // { jobId: "...", status: "processing", createdAt: ..., expiresAt: ... }

  // 2. Poll for the result
  const jobId = jobData.jobId;
  let completed = false;
  const pollInterval = 1000; // Poll every 1 second
  const maxAttempts = 30;

  for (let attempt = 0; attempt < maxAttempts && !completed; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, pollInterval));

    const statusResponse = await fetch(`${API_URL}/jobs/${jobId}`, {
      headers: {
        'x-api-key': API_KEY,
      },
    });

    const status = await statusResponse.json();
    console.log(`Poll attempt ${attempt + 1}:`, status.status);

    if (status.status === 'completed') {
      console.log('Agent response:', status.result.message.content);
      console.log('Processing time:', status.result.processingTimeMs, 'ms');
      completed = true;
    } else if (status.status === 'failed' || status.status === 'timeout') {
      console.error('Job failed:', status.error);
      completed = true;
    }
  }

  if (!completed) {
    console.error('Job timed out after', maxAttempts, 'attempts');
  }
}

// Example 2: Using with JWT authentication
async function jobWithJWTExample() {
  const API_URL = 'http://localhost:3000/api';

  // 1. Login to get JWT token
  const loginResponse = await fetch(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: 'user@example.com',
      username: 'user',
      cdpUserId: 'your-user-uuid',
    }),
  });

  const { token } = await loginResponse.json();

  // 2. Create job with JWT
  const createResponse = await fetch(`${API_URL}/messaging/jobs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      agentId: 'agent-uuid',
      userId: 'your-user-uuid',
      content: 'Analyze the DeFi market trends',
    }),
  });

  const job = await createResponse.json();
  return job;
}

// Example 3: Helper function for polling with async/await
async function pollJobUntilComplete(
  jobId: string,
  options: {
    apiUrl?: string;
    apiKey?: string;
    token?: string;
    interval?: number;
    maxAttempts?: number;
  } = {}
) {
  const {
    apiUrl = 'http://localhost:3000/api/messaging',
    apiKey,
    token,
    interval = 1000,
    maxAttempts = 30,
  } = options;

  const headers: Record<string, string> = {};
  if (apiKey) headers['x-api-key'] = apiKey;
  if (token) headers['Authorization'] = `Bearer ${token}`;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const response = await fetch(`${apiUrl}/jobs/${jobId}`, { headers });
    const status = await response.json();

    if (status.status === 'completed') {
      return {
        success: true,
        result: status.result,
        processingTimeMs: status.result.processingTimeMs,
      };
    }

    if (status.status === 'failed' || status.status === 'timeout') {
      return {
        success: false,
        error: status.error,
      };
    }

    // Still processing, wait before next poll
    await new Promise((resolve) => setTimeout(resolve, interval));
  }

  return {
    success: false,
    error: 'Polling timeout exceeded',
  };
}

// Example 4: Using the helper function
async function helperExample() {
  const API_KEY = 'your-api-key';

  // Create job
  const createResponse = await fetch('http://localhost:3000/api/messaging/jobs', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
    },
    body: JSON.stringify({
      agentId: 'agent-uuid',
      userId: 'user-uuid',
      content: 'What are the top 5 DeFi protocols by TVL?',
    }),
  });

  const { jobId } = await createResponse.json();

  // Poll until complete
  const result = await pollJobUntilComplete(jobId, {
    apiKey: API_KEY,
    interval: 1000,
    maxAttempts: 30,
  });

  if (result.success) {
    console.log('Agent response:', result.result?.message.content);
    console.log('Time taken:', result.processingTimeMs, 'ms');
  } else {
    console.error('Job failed:', result.error);
  }
}

// Example 5: TypeScript SDK-style wrapper
class JobsAPIClient {
  private apiUrl: string;
  private apiKey?: string;
  private token?: string;

  constructor(options: { apiUrl: string; apiKey?: string; token?: string }) {
    this.apiUrl = options.apiUrl;
    this.apiKey = options.apiKey;
    this.token = options.token;
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) headers['x-api-key'] = this.apiKey;
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
    return headers;
  }

  async prompt(options: {
    agentId: string;
    userId: string;
    content: string;
    metadata?: Record<string, unknown>;
    timeoutMs?: number;
  }) {
    const response = await fetch(`${this.apiUrl}/jobs`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(options),
    });

    if (!response.ok) {
      throw new Error(`Failed to create job: ${response.statusText}`);
    }

    return response.json();
  }

  async poll(options: {
    jobId: string;
    interval?: number;
    maxAttempts?: number;
    timeout?: number;
  }) {
    const interval = options.interval || 1000;
    const maxAttempts = options.maxAttempts || 30;
    const timeout = options.timeout || maxAttempts * interval;
    const startTime = Date.now();

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Check timeout
      if (Date.now() - startTime > timeout) {
        throw new Error('Polling timeout exceeded');
      }

      const response = await fetch(`${this.apiUrl}/jobs/${options.jobId}`, {
        headers: this.getHeaders(),
      });

      if (!response.ok) {
        throw new Error(`Failed to get job status: ${response.statusText}`);
      }

      const status = await response.json();

      if (status.status === 'completed') {
        return status;
      }

      if (status.status === 'failed' || status.status === 'timeout') {
        throw new Error(status.error || 'Job failed');
      }

      // Still processing, wait before next poll
      await new Promise((resolve) => setTimeout(resolve, interval));
    }

    throw new Error('Maximum poll attempts exceeded');
  }

  async getJob(jobId: string) {
    const response = await fetch(`${this.apiUrl}/jobs/${jobId}`, {
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Failed to get job: ${response.statusText}`);
    }

    return response.json();
  }
}

// Example 6: Using the SDK-style client
async function sdkStyleExample() {
  const client = new JobsAPIClient({
    apiUrl: 'http://localhost:3000/api/messaging',
    apiKey: 'your-api-key',
  });

  try {
    // Create job
    const job = await client.prompt({
      agentId: 'agent-uuid',
      userId: 'user-uuid',
      content: 'Explain the Uniswap V3 concentrated liquidity model',
    });

    console.log('Job created:', job.jobId);

    // Poll for result
    const result = await client.poll({
      jobId: job.jobId,
      interval: 1000,
      maxAttempts: 30,
    });

    console.log('Agent response:', result.result.message.content);
  } catch (error) {
    console.error('Error:', error);
  }
}

// Export examples
export {
  simpleJobExample,
  jobWithJWTExample,
  pollJobUntilComplete,
  helperExample,
  JobsAPIClient,
  sdkStyleExample,
};


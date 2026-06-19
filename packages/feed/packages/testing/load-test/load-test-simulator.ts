/**
 * Local Load Test Simulator
 *
 * Simulates thousands of concurrent users making requests to test database
 * performance and identify bottlenecks before production deployment.
 */

import { logger } from "@feed/shared";

export interface LoadTestConfig {
  /** Number of concurrent users to simulate */
  concurrentUsers: number;

  /** Duration of test in seconds */
  durationSeconds: number;

  /** Endpoints to test with their weights (probability of being called) */
  endpoints: Array<{
    path: string;
    method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
    weight: number; // 0-1
    headers?: Record<string, string>;
    body?: Record<string, unknown>;
  }>;

  /** Ramp-up time in seconds (gradually increase load) */
  rampUpSeconds?: number;

  /** Think time between requests (ms) */
  thinkTimeMs?: number;

  /** Maximum requests per second (rate limiting) */
  maxRps?: number;
}

export interface LoadTestResult {
  config: LoadTestConfig;
  startTime: Date;
  endTime: Date;
  durationMs: number;

  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;

  responseTime: {
    min: number;
    max: number;
    mean: number;
    median: number;
    p95: number;
    p99: number;
  };

  throughput: {
    requestsPerSecond: number;
    successRate: number;
  };

  errors: Array<{
    endpoint: string;
    error: string;
    count: number;
  }>;

  endpointStats: Record<
    string,
    {
      count: number;
      successCount: number;
      avgResponseTime: number;
      errorCount: number;
    }
  >;
}

interface RequestResult {
  endpoint: string;
  success: boolean;
  responseTime: number;
  error?: string;
  timestamp: Date;
}

export class LoadTestSimulator {
  private baseUrl: string;
  private results: RequestResult[] = [];
  private isRunning = false;
  private startTime: Date = new Date();
  private errorCounts: Map<string, number> = new Map();

  constructor(baseUrl = "http://localhost:3000") {
    this.baseUrl = baseUrl;
  }

  /**
   * Run a load test with the given configuration
   */
  async runTest(config: LoadTestConfig): Promise<LoadTestResult> {
    this.results = [];
    this.errorCounts = new Map();
    this.isRunning = true;
    this.startTime = new Date();

    logger.info(
      "Starting load test",
      {
        concurrentUsers: config.concurrentUsers,
        duration: `${config.durationSeconds}s`,
        endpoints: config.endpoints.length,
      },
      "LoadTestSimulator",
    );

    const endTime = Date.now() + config.durationSeconds * 1000;
    const workers: Promise<void>[] = [];

    // Create worker promises for each concurrent user
    for (let i = 0; i < config.concurrentUsers; i++) {
      const worker = this.simulateUser(config, endTime, i);
      workers.push(worker);

      // Ramp-up: stagger worker starts
      if (config.rampUpSeconds && config.rampUpSeconds > 0) {
        const delayMs = (config.rampUpSeconds * 1000) / config.concurrentUsers;
        await this.sleep(delayMs);
      }
    }

    // Wait for all workers to complete
    await Promise.all(workers);

    this.isRunning = false;
    const testEndTime = new Date();

    // Analyze results
    const result = this.analyzeResults(config, testEndTime);

    logger.info(
      "Load test completed",
      {
        totalRequests: result.totalRequests,
        successRate: `${(result.throughput.successRate * 100).toFixed(2)}%`,
        avgResponseTime: `${result.responseTime.mean.toFixed(2)}ms`,
        p95ResponseTime: `${result.responseTime.p95.toFixed(2)}ms`,
        rps: result.throughput.requestsPerSecond.toFixed(2),
      },
      "LoadTestSimulator",
    );

    return result;
  }

  /**
   * Simulate a single user making requests
   */
  private async simulateUser(
    config: LoadTestConfig,
    endTime: number,
    _userId: number,
  ): Promise<void> {
    let requestCount = 0;

    while (Date.now() < endTime && this.isRunning) {
      // Rate limiting
      if (config.maxRps) {
        const expectedRequests = Math.floor(
          ((Date.now() - this.startTime.getTime()) / 1000) * config.maxRps,
        );
        if (requestCount >= expectedRequests / config.concurrentUsers) {
          await this.sleep(10);
          continue;
        }
      }

      // Select endpoint based on weights
      const endpoint = this.selectEndpoint(config.endpoints);

      // Make request
      await this.makeRequest(endpoint);
      requestCount++;

      // Think time (simulate user reading/processing)
      if (config.thinkTimeMs) {
        await this.sleep(config.thinkTimeMs);
      }
    }
  }

  /**
   * Select an endpoint based on weights
   */
  private selectEndpoint(
    endpoints: LoadTestConfig["endpoints"],
  ): LoadTestConfig["endpoints"][0] {
    if (endpoints.length === 0) {
      throw new Error("No endpoints provided for load testing");
    }

    const rand = Math.random();
    let cumulative = 0;

    for (const endpoint of endpoints) {
      cumulative += endpoint.weight;
      if (rand <= cumulative) {
        return endpoint;
      }
    }

    // Fallback to last endpoint if weights don't sum to 1
    return endpoints[endpoints.length - 1]!;
  }

  /**
   * Make a request to an endpoint
   */
  private async makeRequest(
    endpoint: LoadTestConfig["endpoints"][0],
  ): Promise<void> {
    const startTime = Date.now();
    const url = `${this.baseUrl}${endpoint.path}`;

    const response = await fetch(url, {
      method: endpoint.method,
      headers: {
        "Content-Type": "application/json",
        ...endpoint.headers,
      },
      body: endpoint.body ? JSON.stringify(endpoint.body) : undefined,
    });

    const responseTime = Date.now() - startTime;
    const success = response.ok;

    if (!success) {
      const errorKey = `${endpoint.path}:${response.status}`;
      this.errorCounts.set(errorKey, (this.errorCounts.get(errorKey) || 0) + 1);
    }

    this.results.push({
      endpoint: endpoint.path,
      success,
      responseTime,
      error: success ? undefined : `HTTP ${response.status}`,
      timestamp: new Date(),
    });
  }

  /**
   * Analyze test results
   * NOTE: Response time calculations ONLY use successful requests
   */
  private analyzeResults(
    config: LoadTestConfig,
    endTime: Date,
  ): LoadTestResult {
    const successfulResults = this.results.filter((r) => r.success);
    const responseTimes = successfulResults
      .map((r) => r.responseTime)
      .sort((a, b) => a - b);

    const durationMs = endTime.getTime() - this.startTime.getTime();

    // Calculate percentiles (only from successful requests)
    const p95Index = Math.floor(responseTimes.length * 0.95);
    const p99Index = Math.floor(responseTimes.length * 0.99);
    const medianIndex = Math.floor(responseTimes.length * 0.5);

    // Aggregate endpoint stats (only successful requests for avg time)
    const endpointStats: Record<
      string,
      {
        count: number;
        successCount: number;
        avgResponseTime: number;
        errorCount: number;
      }
    > = {};

    for (const result of this.results) {
      if (!endpointStats[result.endpoint]) {
        endpointStats[result.endpoint] = {
          count: 0,
          successCount: 0,
          avgResponseTime: 0,
          errorCount: 0,
        };
      }

      const stats = endpointStats[result.endpoint]!;
      stats.count++;

      if (result.success) {
        stats.successCount++;
        // Only calculate avg response time from successful requests
        stats.avgResponseTime =
          (stats.avgResponseTime * (stats.successCount - 1) +
            result.responseTime) /
          stats.successCount;
      } else {
        stats.errorCount++;
      }
    }

    // Aggregate errors
    const errors = Array.from(this.errorCounts.entries()).map(
      ([key, count]) => {
        const parts = key.split(":");
        if (parts.length < 2) {
          throw new Error(`Invalid error key format: ${key}`);
        }
        const [endpoint, ...errorParts] = parts;
        return { endpoint: endpoint!, error: errorParts.join(":"), count };
      },
    );

    return {
      config,
      startTime: this.startTime,
      endTime,
      durationMs,

      totalRequests: this.results.length,
      successfulRequests: successfulResults.length,
      failedRequests: this.results.length - successfulResults.length,

      responseTime: {
        min: responseTimes[0] || 0,
        max: responseTimes[responseTimes.length - 1] || 0,
        mean:
          responseTimes.length > 0
            ? responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length
            : 0,
        median: responseTimes[medianIndex] || 0,
        p95: responseTimes[p95Index] || 0,
        p99: responseTimes[p99Index] || 0,
      },

      throughput: {
        requestsPerSecond: this.results.length / (durationMs / 1000),
        successRate:
          this.results.length > 0
            ? successfulResults.length / this.results.length
            : 0,
      },

      errors,
      endpointStats,
    };
  }

  /**
   * Stop the running test
   */
  stop(): void {
    this.isRunning = false;
  }

  /**
   * Sleep for a given duration
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Helper to generate A2A endpoint for mixed testing
 */
function generateA2AEndpoint(
  method: string,
  params: Record<string, unknown> = {},
) {
  return {
    jsonrpc: "2.0",
    method,
    params,
    id: Math.floor(Math.random() * 1000000),
  };
}

/**
 * A2A headers for testing
 */
const A2A_HEADERS = {
  "Content-Type": "application/json",
  "x-agent-id": "load-test-agent",
  "x-agent-address": "0x1234567890123456789012345678901234567890",
  "x-agent-token-id": "1",
};

/**
 * Predefined test scenarios
 */
export const TEST_SCENARIOS = {
  /** Light load: 100 users for 1 minute */
  LIGHT: {
    concurrentUsers: 100,
    durationSeconds: 60,
    rampUpSeconds: 10,
    thinkTimeMs: 1000,
    endpoints: [
      { path: "/api/posts", method: "GET" as const, weight: 0.35 },
      {
        path: "/api/feed/widgets/trending-posts",
        method: "GET" as const,
        weight: 0.18,
      },
      { path: "/api/users/me", method: "GET" as const, weight: 0.17 },
      { path: "/api/leaderboard", method: "GET" as const, weight: 0.1 },
      { path: "/api/notifications", method: "GET" as const, weight: 0.1 },
      // A2A endpoints (10% of traffic)
      {
        path: "/api/a2a",
        method: "POST" as const,
        weight: 0.05,
        headers: A2A_HEADERS,
        body: generateA2AEndpoint("a2a.getBalance"),
      },
      {
        path: "/api/a2a",
        method: "POST" as const,
        weight: 0.05,
        headers: A2A_HEADERS,
        body: generateA2AEndpoint("a2a.getPositions"),
      },
    ],
  },

  /** Normal load: 500 users for 2 minutes */
  NORMAL: {
    concurrentUsers: 500,
    durationSeconds: 120,
    rampUpSeconds: 20,
    thinkTimeMs: 500,
    endpoints: [
      { path: "/api/posts", method: "GET" as const, weight: 0.3 },
      {
        path: "/api/posts/feed/favorites",
        method: "GET" as const,
        weight: 0.13,
      },
      {
        path: "/api/feed/widgets/trending-posts",
        method: "GET" as const,
        weight: 0.12,
      },
      { path: "/api/users/me", method: "GET" as const, weight: 0.13 },
      { path: "/api/leaderboard", method: "GET" as const, weight: 0.09 },
      { path: "/api/notifications", method: "GET" as const, weight: 0.08 },
      // A2A endpoints (15% of traffic)
      {
        path: "/api/a2a",
        method: "POST" as const,
        weight: 0.05,
        headers: A2A_HEADERS,
        body: generateA2AEndpoint("a2a.getBalance"),
      },
      {
        path: "/api/a2a",
        method: "POST" as const,
        weight: 0.05,
        headers: A2A_HEADERS,
        body: generateA2AEndpoint("a2a.getPositions"),
      },
      {
        path: "/api/a2a",
        method: "POST" as const,
        weight: 0.05,
        headers: A2A_HEADERS,
        body: generateA2AEndpoint("a2a.getFeed"),
      },
    ],
  },

  /** Heavy load: 1000 users for 5 minutes */
  HEAVY: {
    concurrentUsers: 1000,
    durationSeconds: 300,
    rampUpSeconds: 30,
    thinkTimeMs: 200,
    maxRps: 1000,
    endpoints: [
      // Public endpoints only to avoid 401 errors
      { path: "/api/posts?limit=20", method: "GET" as const, weight: 0.3 },
      {
        path: "/api/feed/widgets/trending-posts",
        method: "GET" as const,
        weight: 0.22,
      },
      { path: "/api/leaderboard", method: "GET" as const, weight: 0.18 },
      { path: "/api/feed/widgets/stats", method: "GET" as const, weight: 0.08 },
      {
        path: "/api/feed/widgets/markets",
        method: "GET" as const,
        weight: 0.07,
      },
      // A2A endpoints (15% of traffic)
      {
        path: "/api/a2a",
        method: "POST" as const,
        weight: 0.05,
        headers: A2A_HEADERS,
        body: generateA2AEndpoint("a2a.getBalance"),
      },
      {
        path: "/api/a2a",
        method: "POST" as const,
        weight: 0.05,
        headers: A2A_HEADERS,
        body: generateA2AEndpoint("a2a.getPositions"),
      },
      {
        path: "/api/a2a",
        method: "POST" as const,
        weight: 0.05,
        headers: A2A_HEADERS,
        body: generateA2AEndpoint("a2a.getLeaderboard"),
      },
    ],
  },

  /** Stress test: 2000+ users for 5 minutes */
  STRESS: {
    concurrentUsers: 2000,
    durationSeconds: 300,
    rampUpSeconds: 60,
    thinkTimeMs: 100,
    maxRps: 2000,
    endpoints: [
      // Public endpoints only for now (no 401 errors)
      { path: "/api/posts", method: "GET" as const, weight: 0.25 },
      {
        path: "/api/feed/widgets/trending-posts",
        method: "GET" as const,
        weight: 0.17,
      },
      { path: "/api/leaderboard", method: "GET" as const, weight: 0.18 },
      { path: "/api/feed/widgets/stats", method: "GET" as const, weight: 0.13 },
      {
        path: "/api/feed/widgets/markets",
        method: "GET" as const,
        weight: 0.12,
      },
      // A2A endpoints (15% of traffic)
      {
        path: "/api/a2a",
        method: "POST" as const,
        weight: 0.05,
        headers: A2A_HEADERS,
        body: generateA2AEndpoint("a2a.getBalance"),
      },
      {
        path: "/api/a2a",
        method: "POST" as const,
        weight: 0.05,
        headers: A2A_HEADERS,
        body: generateA2AEndpoint("a2a.getPositions"),
      },
      {
        path: "/api/a2a",
        method: "POST" as const,
        weight: 0.05,
        headers: A2A_HEADERS,
        body: generateA2AEndpoint("a2a.getSystemStats"),
      },
    ],
  },
};

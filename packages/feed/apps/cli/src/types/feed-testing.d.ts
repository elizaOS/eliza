declare module "@feed/testing" {
  export type LoadTestConfig = {
    concurrentUsers: number;
    durationSeconds: number;
    endpoints: Array<{
      path: string;
      method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
      weight: number;
      headers?: Record<string, string>;
      body?: Record<string, unknown>;
    }>;
    rampUpSeconds?: number;
    thinkTimeMs?: number;
    maxRps?: number;
    [key: string]: unknown;
  };

  export type LoadTestError = {
    endpoint: string;
    error: string;
    count: number;
  };

  export type LoadTestResult = {
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
    errors: LoadTestError[];
    endpointStats: Record<
      string,
      {
        count: number;
        successCount: number;
        avgResponseTime: number;
        errorCount: number;
      }
    >;
  };

  export class LoadTestSimulator {
    constructor(baseUrl: string);
    runTest(config: LoadTestConfig): Promise<LoadTestResult>;
    stop(): void;
  }

  export const TEST_SCENARIOS: Record<string, LoadTestConfig>;
  export const A2A_TEST_SCENARIOS: Record<string, LoadTestConfig>;
}

/**
 * Enhanced Load Test Simulator
 *
 * Features:
 * - Single-route DDOS testing
 * - All-routes DDOS testing
 * - Performance monitoring integration
 * - Cache, storage, and database metrics
 * - Bottleneck identification
 * - Comprehensive reporting
 */

import { performanceMonitor } from "@feed/api";
import { logger } from "@feed/shared";
import type { LoadTestConfig, LoadTestResult } from "./load-test-simulator";
import { ResourceLimiter, type ResourceLimits } from "./resource-limiter";

export interface EnhancedLoadTestConfig extends LoadTestConfig {
  /** Test type */
  testType: "mixed" | "single-route" | "all-routes-ddos";

  /** For single-route DDOS, which route to target */
  targetRoute?: string;

  /** Enable detailed performance monitoring */
  enableMonitoring?: boolean;

  /** Track individual request traces */
  enableTracing?: boolean;

  /** Resource limits to prevent OOM */
  resourceLimits?: Partial<ResourceLimits>;
}

export interface EnhancedLoadTestResult extends LoadTestResult {
  /** Performance metrics from monitoring */
  performanceMetrics?: {
    cache: {
      hitRate: number;
      avgLatencyMs: number;
      operations: {
        get: number;
        set: number;
        delete: number;
      };
    };
    database: {
      slowQueryRate: number;
      cpuIntensiveOps: string[];
      slowestOperations: Array<{
        operation: string;
        avgDuration: number;
        count: number;
      }>;
    };
    storage: {
      uploads: number;
      downloads: number;
      errors: number;
      avgUploadLatencyMs: number;
      avgDownloadLatencyMs: number;
    };
    system: {
      peakMemoryMB: number;
      avgMemoryMB: number;
      peakActiveRequests: number;
      avgRequestsPerSecond: number;
    };
  };

  /** Identified bottlenecks */
  bottlenecks?: Array<{
    type: string;
    severity: string;
    description: string;
  }>;

  /** Optimization recommendations */
  recommendations?: string[];
}

interface RequestTrace {
  endpoint: string;
  startTime: number;
  endTime: number;
  responseTime: number;
  statusCode: number;
  cacheHit?: boolean;
  dbQueries?: number;
  storageOps?: number;
}

export class EnhancedLoadTestSimulator {
  private baseUrl: string;
  private results: RequestTrace[] = [];
  private isRunning = false;
  private startTime: Date = new Date();
  private errorCounts: Map<string, number> = new Map();
  private enableMonitoring = true;
  private resourceLimiter: ResourceLimiter | null = null;

  constructor(baseUrl = "http://localhost:3000") {
    this.baseUrl = baseUrl;
  }

  /**
   * Run an enhanced load test
   */
  async runTest(
    config: EnhancedLoadTestConfig,
  ): Promise<EnhancedLoadTestResult> {
    this.results = [];
    this.errorCounts = new Map();
    this.isRunning = true;
    this.startTime = new Date();
    this.enableMonitoring = config.enableMonitoring ?? true;

    // Initialize resource limiter to prevent OOM
    this.resourceLimiter = new ResourceLimiter(config.resourceLimits);
    this.resourceLimiter.start(() => {
      logger.error(
        "Resource limiter triggered emergency stop",
        undefined,
        "EnhancedLoadTestSimulator",
      );
      this.stop();
    });

    // Reset performance monitor
    if (this.enableMonitoring) {
      performanceMonitor.reset();
    }

    logger.info(
      "Starting enhanced load test",
      {
        testType: config.testType,
        concurrentUsers: config.concurrentUsers,
        duration: `${config.durationSeconds}s`,
        endpoints: config.endpoints.length,
        targetRoute: config.targetRoute,
        monitoring: this.enableMonitoring,
      },
      "EnhancedLoadTestSimulator",
    );

    // Adjust endpoints based on test type
    const testEndpoints = this.prepareEndpoints(config);

    const endTime = Date.now() + config.durationSeconds * 1000;
    const workers: Promise<void>[] = [];

    // Create worker promises for each concurrent user
    for (let i = 0; i < config.concurrentUsers; i++) {
      const worker = this.simulateUser(
        { ...config, endpoints: testEndpoints },
        endTime,
        i,
      );
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

    // Stop resource monitoring
    if (this.resourceLimiter) {
      this.resourceLimiter.stop();
    }

    // Analyze results with performance metrics
    const result = this.analyzeResults(config, testEndTime);

    logger.info(
      "Enhanced load test completed",
      {
        totalRequests: result.totalRequests,
        successRate: `${(result.throughput.successRate * 100).toFixed(2)}%`,
        avgResponseTime: `${result.responseTime.mean.toFixed(2)}ms`,
        p95ResponseTime: `${result.responseTime.p95.toFixed(2)}ms`,
        bottlenecks: result.bottlenecks?.length || 0,
      },
      "EnhancedLoadTestSimulator",
    );

    return result;
  }

  /**
   * Prepare endpoints based on test type
   */
  private prepareEndpoints(
    config: EnhancedLoadTestConfig,
  ): LoadTestConfig["endpoints"] {
    switch (config.testType) {
      case "single-route":
        // DDOS a single route
        if (!config.targetRoute) {
          throw new Error("targetRoute required for single-route DDOS test");
        }
        return [
          {
            path: config.targetRoute,
            method: "GET",
            weight: 1.0,
          },
        ];

      case "all-routes-ddos": {
        // DDOS all routes equally
        const equalWeight = 1.0 / config.endpoints.length;
        return config.endpoints.map((ep) => ({
          ...ep,
          weight: equalWeight,
        }));
      }
      default:
        // Use provided weights
        return config.endpoints;
    }
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
      // Check resource limits
      if (this.resourceLimiter && !this.resourceLimiter.canMakeRequest()) {
        await this.sleep(100); // Back off if resources constrained
        continue;
      }

      if (this.resourceLimiter?.isStopped()) {
        logger.warn(
          "Resource limiter stopped test",
          undefined,
          "EnhancedLoadTestSimulator",
        );
        break;
      }
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

    if (this.enableMonitoring) {
      performanceMonitor.startRequest();
    }

    if (this.resourceLimiter) {
      this.resourceLimiter.requestStarted();
    }

    const response = await fetch(url, {
      method: endpoint.method,
      headers: {
        "Content-Type": "application/json",
        ...endpoint.headers,
      },
      body: endpoint.body ? JSON.stringify(endpoint.body) : undefined,
    });

    const statusCode = response.status;
    const success = response.ok;

    if (!success) {
      const errorKey = `${endpoint.path}:${response.status}`;
      this.errorCounts.set(errorKey, (this.errorCounts.get(errorKey) || 0) + 1);
    }

    if (this.enableMonitoring) {
      performanceMonitor.endRequest();
    }

    if (this.resourceLimiter) {
      this.resourceLimiter.requestEnded();
    }

    const responseTime = Date.now() - startTime;

    this.results.push({
      endpoint: endpoint.path,
      startTime,
      endTime: Date.now(),
      responseTime,
      statusCode,
    });
  }

  /**
   * Analyze test results with performance metrics
   */
  private analyzeResults(
    config: EnhancedLoadTestConfig,
    endTime: Date,
  ): EnhancedLoadTestResult {
    const successfulResults = this.results.filter(
      (r) => r.statusCode >= 200 && r.statusCode < 300,
    );
    const responseTimes = successfulResults
      .map((r) => r.responseTime)
      .sort((a, b) => a - b);
    const durationMs = endTime.getTime() - this.startTime.getTime();

    // Calculate percentiles
    const p95Index = Math.floor(responseTimes.length * 0.95);
    const p99Index = Math.floor(responseTimes.length * 0.99);
    const medianIndex = Math.floor(responseTimes.length * 0.5);

    // Aggregate endpoint stats
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

      const success = result.statusCode >= 200 && result.statusCode < 300;
      if (success) {
        stats.successCount++;
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

    // Get performance metrics if monitoring enabled
    let performanceMetrics;
    let bottlenecks;
    let recommendations;

    if (this.enableMonitoring) {
      const perfSnapshot = performanceMonitor.getStats();
      const perfBottlenecks = performanceMonitor.identifyBottlenecks();
      const perfRecommendations = performanceMonitor.getRecommendations();

      // Extract slow operations
      const slowestOps = Object.entries(
        perfSnapshot.database.operationBreakdown,
      )
        .sort((a, b) => b[1].avgDuration - a[1].avgDuration)
        .slice(0, 10)
        .map(([operation, stats]) => ({
          operation,
          avgDuration: stats.avgDuration,
          count: stats.count,
        }));

      // Extract CPU-intensive operations
      const cpuIntensiveOps = Object.entries(
        perfSnapshot.database.operationBreakdown,
      )
        .filter(([, stats]) => stats.cpuIntensive)
        .map(([operation]) => operation);

      // Calculate memory stats across all snapshots
      const snapshots = performanceMonitor.getSnapshots();
      const memoryUsages = snapshots.map((s) => s.system.memoryUsageMB);
      const activeRequestCounts = snapshots.map((s) => s.system.activeRequests);
      const rpsValues = snapshots.map((s) => s.system.requestsPerSecond);

      performanceMetrics = {
        cache: {
          hitRate: performanceMonitor.getCacheHitRate(),
          avgLatencyMs: perfSnapshot.cache.avgLatencyMs,
          operations: perfSnapshot.cache.operations,
        },
        database: {
          slowQueryRate:
            perfSnapshot.database.queries > 0
              ? perfSnapshot.database.slowQueries /
                perfSnapshot.database.queries
              : 0,
          cpuIntensiveOps,
          slowestOperations: slowestOps,
        },
        storage: {
          uploads: perfSnapshot.storage.uploads,
          downloads: perfSnapshot.storage.downloads,
          errors: perfSnapshot.storage.errors,
          avgUploadLatencyMs: perfSnapshot.storage.avgUploadLatencyMs,
          avgDownloadLatencyMs: perfSnapshot.storage.avgDownloadLatencyMs,
        },
        system: {
          peakMemoryMB: Math.max(...memoryUsages, 0),
          avgMemoryMB:
            memoryUsages.length > 0
              ? memoryUsages.reduce((a, b) => a + b, 0) / memoryUsages.length
              : 0,
          peakActiveRequests: Math.max(...activeRequestCounts, 0),
          avgRequestsPerSecond:
            rpsValues.length > 0
              ? rpsValues.reduce((a, b) => a + b, 0) / rpsValues.length
              : 0,
        },
      };

      bottlenecks = perfBottlenecks.map((b) => ({
        type: b.type,
        severity: b.severity,
        description: b.description,
      }));

      recommendations = perfRecommendations;
    }

    const result: EnhancedLoadTestResult = {
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
      performanceMetrics,
      bottlenecks,
      recommendations,
    };

    return result;
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
 * Generate test scenarios for all routes
 */
export async function generateAllRoutesScenario(
  baseUrl = "http://localhost:3000",
): Promise<EnhancedLoadTestConfig["endpoints"]> {
  // Fetch OpenAPI spec to discover all routes
  const response = await fetch(`${baseUrl}/api/docs`);
  const spec = (await response.json()) as {
    paths?: Record<string, Record<string, unknown>>;
  };

  const endpoints: EnhancedLoadTestConfig["endpoints"] = [];

  if (spec.paths) {
    for (const [path, methods] of Object.entries(spec.paths)) {
      for (const method of Object.keys(methods)) {
        if (
          ["get", "post", "put", "delete", "patch"].includes(
            method.toLowerCase(),
          )
        ) {
          endpoints.push({
            path,
            method: method.toUpperCase() as
              | "GET"
              | "POST"
              | "PUT"
              | "DELETE"
              | "PATCH",
            weight: 1.0 / Object.keys(spec.paths).length,
          });
        }
      }
    }
  }

  return endpoints;
}

/**
 * Predefined enhanced test scenarios
 */
export const ENHANCED_TEST_SCENARIOS = {
  /** Test single route under heavy load */
  SINGLE_ROUTE_DDOS: (route: string): EnhancedLoadTestConfig => ({
    testType: "single-route",
    targetRoute: route,
    concurrentUsers: 500, // Reduced from 1000 to prevent OOM
    durationSeconds: 30, // Reduced from 60 for safety
    rampUpSeconds: 5,
    thinkTimeMs: 50, // Added think time to reduce load
    maxRps: 2000, // Reduced from 10000 to prevent OOM
    endpoints: [], // Will be overridden
    enableMonitoring: true,
    enableTracing: false, // Disabled to save memory
    resourceLimits: {
      maxMemoryMB: 1024, // 1GB limit
      maxMemoryPercent: 75, // 75% max
      maxConcurrentRequests: 2000,
    },
  }),

  /** Test all routes equally under heavy load */
  ALL_ROUTES_DDOS: (
    endpoints: EnhancedLoadTestConfig["endpoints"],
  ): EnhancedLoadTestConfig => ({
    testType: "all-routes-ddos",
    concurrentUsers: 2000,
    durationSeconds: 120,
    rampUpSeconds: 20,
    thinkTimeMs: 0,
    maxRps: 5000,
    endpoints,
    enableMonitoring: true,
    enableTracing: false,
  }),

  /** Mixed traffic with monitoring */
  REALISTIC_LOAD: (
    endpoints: EnhancedLoadTestConfig["endpoints"],
  ): EnhancedLoadTestConfig => ({
    testType: "mixed",
    concurrentUsers: 500,
    durationSeconds: 300,
    rampUpSeconds: 30,
    thinkTimeMs: 200,
    maxRps: 1000,
    endpoints,
    enableMonitoring: true,
    enableTracing: false,
  }),
};

/**
 * Type definitions for the benchmark testing framework
 */

export interface TestPrompt {
  id: string;
  category: "typewriter" | "multiverse-math" | "relational-data";
  prompt: string;
  expectedPatterns: string[]; // Patterns to look for in the response
  expectedActions?: string[]; // Expected action names to be called
  timeout?: number; // Custom timeout in ms (default: 5000)
  setup?: TestPrompt[]; // Setup prompts to run before this test
}

export interface TestResult {
  promptId: string;
  prompt: string;
  success: boolean;
  responseTime: number; // in ms
  response: string;
  matchedPatterns: string[];
  error?: string;
  timestamp: number;
}

export interface PerformanceMetrics {
  category: string;
  totalTests: number;
  successfulTests: number;
  failedTests: number;
  p50: number; // median response time
  p95: number; // 95th percentile response time
  p99: number; // 99th percentile response time
  mean: number;
  min: number;
  max: number;
  stdDev: number;
}

export interface TestSession {
  sessionId: string;
  startTime: number;
  endTime?: number;
  results: TestResult[];
  metrics?: PerformanceMetrics[];
}

export interface SocketMessage {
  type: string;
  userId?: string;
  roomId?: string;
  text?: string;
  [key: string]: any;
}

export interface ElizaResponse {
  text: string;
  actions?: string[];
  state?: any;
  timestamp: number;
}

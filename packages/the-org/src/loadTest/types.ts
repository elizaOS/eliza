export interface LoadTestMetrics {
  totalTime: number;
  errorCount: number;
  messagesSent: number;
  messagesProcessed: number;
  avgResponseTime: number;
  minResponseTime: number;
  maxResponseTime: number;
  responseTimes: number[];
  peakMemoryUsage: number;
  memoryUsageStart: number;
  memoryUsageEnd: number;
  successRate: number;
  throughput: number;
  timeoutCount: number;
  errorTypes: { [key: string]: number };
}

export interface ScaleConfig {
  agents: number;
  messageCount: number;
  description: string;
}

export interface SystemMetrics {
  cpuUsage: number[];
  memoryUsage: number[];
  timestamp: number[];
}

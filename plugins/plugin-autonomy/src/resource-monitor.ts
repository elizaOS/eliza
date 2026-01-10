import { Service, type IAgentRuntime } from '@elizaos/core';
import * as os from 'os';
import { AutonomyLogger } from './logging';
import { ResourceStatus } from './types';

export class ResourceMonitorService extends Service {
  static serviceType = 'resource-monitor';
  capabilityDescription = 'Real-time system resource monitoring';

  private logger: AutonomyLogger;
  private monitoringInterval: NodeJS.Timeout | null = null;
  private currentStatus: ResourceStatus = {
    cpu: 0,
    memory: 0,
    diskSpace: 0,
    apiCalls: {},
    taskSlots: { used: 0, total: 5 },
  };
  private cpuHistory: number[] = [];
  private apiCallTracker: Map<string, { count: number; resetTime: number }> = new Map();
  declare runtime: IAgentRuntime;

  constructor(runtime: IAgentRuntime) {
    super();
    this.runtime = runtime;
    this.logger = new AutonomyLogger(runtime);
  }

  async initialize() {
    this.startMonitoring();
    this.logger.info('Resource monitor service initialized');
  }

  private startMonitoring() {
    // Update every 5 seconds
    this.monitoringInterval = setInterval(() => {
      this.updateResourceStatus();
    }, 5000);

    // Initial update
    this.updateResourceStatus();
  }

  private async updateResourceStatus() {
    try {
      // CPU Usage
      const cpuUsage = this.calculateCPUUsage();
      this.cpuHistory.push(cpuUsage);
      if (this.cpuHistory.length > 12) {
        // Keep 1 minute of history
        this.cpuHistory.shift();
      }
      this.currentStatus.cpu = Math.round(
        this.cpuHistory.reduce((a, b) => a + b, 0) / this.cpuHistory.length
      );

      // Memory Usage
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const usedMem = totalMem - freeMem;
      this.currentStatus.memory = Math.round((usedMem / totalMem) * 100);

      // Disk Space (simplified - just check temp directory)
      this.currentStatus.diskSpace = await this.getDiskUsage();

      // Clean up old API call tracking
      this.cleanupApiCallTracking();

      // Log if resources are constrained
      if (this.currentStatus.cpu > 80 || this.currentStatus.memory > 80) {
        this.logger.warn('High resource usage detected', {
          cpu: this.currentStatus.cpu,
          memory: this.currentStatus.memory,
        });
      }
    } catch (error) {
      this.logger.error('Failed to update resource status', error as Error);
    }
  }

  private calculateCPUUsage(): number {
    const cpus = os.cpus();
    let totalIdle = 0;
    let totalTick = 0;

    cpus.forEach((cpu) => {
      for (const type in cpu.times) {
        totalTick += cpu.times[type as keyof typeof cpu.times];
      }
      totalIdle += cpu.times.idle;
    });

    const idle = totalIdle / cpus.length;
    const total = totalTick / cpus.length;
    const usage = 100 - ~~((100 * idle) / total);

    return Math.max(0, Math.min(100, usage));
  }

  private async getDiskUsage(): Promise<number> {
    // This is a simplified implementation
    // In production, you'd use a proper disk usage library
    try {
      const tmpDir = os.tmpdir();
      // For now, return a mock value
      // In real implementation, you'd check actual disk usage
      return 50 + Math.random() * 20; // 50-70%
    } catch {
      return 0;
    }
  }

  private cleanupApiCallTracking() {
    const now = Date.now();
    const oneHourAgo = now - 3600000;

    for (const [api, tracker] of this.apiCallTracker.entries()) {
      if (tracker.resetTime < oneHourAgo) {
        this.apiCallTracker.delete(api);
      }
    }
  }

  trackApiCall(api: string) {
    const now = Date.now();
    const tracker = this.apiCallTracker.get(api);

    if (!tracker) {
      this.apiCallTracker.set(api, {
        count: 1,
        resetTime: now + 3600000, // Reset after 1 hour
      });
    } else if (tracker.resetTime < now) {
      // Reset the counter
      tracker.count = 1;
      tracker.resetTime = now + 3600000;
    } else {
      tracker.count++;
    }

    // Update current status
    this.currentStatus.apiCalls = {};
    for (const [api, tracker] of this.apiCallTracker.entries()) {
      this.currentStatus.apiCalls[api] = tracker.count;
    }
  }

  updateTaskSlots(used: number) {
    this.currentStatus.taskSlots.used = Math.max(
      0,
      Math.min(used, this.currentStatus.taskSlots.total)
    );
  }

  getResourceStatus(): ResourceStatus {
    return { ...this.currentStatus };
  }

  isResourceConstrained(): boolean {
    return (
      this.currentStatus.cpu > 80 ||
      this.currentStatus.memory > 80 ||
      this.currentStatus.taskSlots.used >= this.currentStatus.taskSlots.total
    );
  }

  getResourceConstraints(): string[] {
    const constraints: string[] = [];

    if (this.currentStatus.cpu > 80) {
      constraints.push(`High CPU usage: ${this.currentStatus.cpu}%`);
    }

    if (this.currentStatus.memory > 80) {
      constraints.push(`High memory usage: ${this.currentStatus.memory}%`);
    }

    if (this.currentStatus.taskSlots.used >= this.currentStatus.taskSlots.total) {
      constraints.push('All task slots in use');
    }

    if (this.currentStatus.diskSpace > 85) {
      constraints.push(`Low disk space: ${100 - this.currentStatus.diskSpace}% free`);
    }

    return constraints;
  }

  async stop() {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }
    this.logger.info('Resource monitor service stopped');
  }

  static async start(runtime: IAgentRuntime): Promise<Service> {
    const service = new ResourceMonitorService(runtime);
    await service.initialize();
    return service;
  }
}

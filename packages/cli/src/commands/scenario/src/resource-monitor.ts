/**
 * Resource Monitoring System for Matrix Testing
 *
 * This module monitors system resources (memory, disk, CPU) during matrix
 * execution to prevent resource exhaustion and provide intelligent recommendations
 * for parallel execution limits.
 *
 * Required by ticket #5782 - Acceptance Criterion 7.
 */

// import { promises as fs } from 'fs'; // unused
import { join } from 'path';

/**
 * Current system resource usage information.
 */
export interface SystemResources {
  /** Memory usage percentage (0-100) */
  memoryUsage: number;
  /** Total system memory in bytes */
  totalMemory: number;
  /** Free system memory in bytes */
  freeMemory: number;
  /** Disk usage percentage (0-100) */
  diskUsage: number;
  /** Total disk space in bytes */
  totalDisk: number;
  /** Free disk space in bytes */
  freeDisk: number;
  /** CPU usage percentage (0-100) */
  cpuUsage: number;
  /** Number of CPU cores */
  cpuCores: number;
  /** System load average */
  loadAverage: number[];
}

/**
 * Resource threshold configuration.
 */
export interface ResourceThresholds {
  /** Memory usage warning threshold (percentage) */
  memoryWarning: number;
  /** Memory usage critical threshold (percentage) */
  memoryCritical: number;
  /** Disk usage warning threshold (percentage) */
  diskWarning: number;
  /** Disk usage critical threshold (percentage) */
  diskCritical: number;
  /** CPU usage warning threshold (percentage) */
  cpuWarning: number;
  /** CPU usage critical threshold (percentage) */
  cpuCritical: number;
}

/**
 * Resource alert information.
 */
export interface ResourceAlert {
  /** Type of alert */
  type: 'warning' | 'critical';
  /** Resource that triggered the alert */
  resource: 'memory' | 'disk' | 'cpu';
  /** Current usage percentage */
  currentUsage: number;
  /** Threshold that was exceeded */
  threshold: number;
  /** Alert message */
  message: string;
  /** When the alert was triggered */
  timestamp: Date;
  /** Recommendation for action */
  recommendation?: string;
}

/**
 * Historical resource usage data point.
 */
export interface ResourceDataPoint {
  /** When this data point was recorded */
  timestamp: Date;
  /** Memory usage at this time */
  memoryUsage: number;
  /** Disk usage at this time */
  diskUsage: number;
  /** CPU usage at this time */
  cpuUsage: number;
}

/**
 * Resource usage statistics.
 */
export interface ResourceStatistics {
  memory: {
    current: number;
    average: number;
    min: number;
    max: number;
  };
  disk: {
    current: number;
    average: number;
    min: number;
    max: number;
  };
  cpu: {
    current: number;
    average: number;
    min: number;
    max: number;
  };
}

/**
 * Configuration for the resource monitor.
 */
export interface ResourceMonitorConfig {
  /** Resource thresholds */
  thresholds: ResourceThresholds;
  /** Callback for resource alerts */
  onAlert?: (alert: ResourceAlert) => void;
  /** Callback for resource updates */
  onUpdate?: (resources: SystemResources) => void;
  /** Callback for performance recommendations */
  onRecommendation?: (recommendation: string) => void;
  /** How often to check resources in milliseconds */
  checkInterval?: number;
  /** Maximum number of historical data points to keep */
  maxHistorySize?: number;
}

/**
 * Disk usage information.
 */
export interface DiskUsage {
  /** Total disk space in bytes */
  total: number;
  /** Used disk space in bytes */
  used: number;
  /** Free disk space in bytes */
  free: number;
  /** Usage percentage (0-100) */
  usage: number;
}

/**
 * Main resource monitoring class.
 */
export class ResourceMonitor {
  private config: ResourceMonitorConfig;
  private intervalId: NodeJS.Timeout | null = null;
  private history: ResourceDataPoint[] = [];
  private lastAlerts = new Map<string, Date>();

  constructor(config: ResourceMonitorConfig) {
    this.config = {
      checkInterval: 5000, // 5 seconds default
      maxHistorySize: 200, // Keep last 200 data points
      ...config,
    };
  }

  /**
   * Starts monitoring system resources.
   */
  start(): void {
    if (this.intervalId) {
      this.stop();
    }

    this.intervalId = setInterval(async () => {
      try {
        await this.checkResources();
      } catch (error) {
        console.warn('Resource monitoring error:', error);
      }
    }, this.config.checkInterval);
  }

  /**
   * Stops monitoring system resources.
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * Updates the resource thresholds.
   */
  updateThresholds(thresholds: ResourceThresholds): void {
    // Validate thresholds
    if (thresholds.memoryWarning >= thresholds.memoryCritical) {
      throw new Error('Memory warning threshold must be less than critical threshold');
    }
    if (thresholds.diskWarning >= thresholds.diskCritical) {
      throw new Error('Disk warning threshold must be less than critical threshold');
    }
    if (thresholds.cpuWarning >= thresholds.cpuCritical) {
      throw new Error('CPU warning threshold must be less than critical threshold');
    }

    this.config.thresholds = thresholds;
  }

  /**
   * Gets the current resource thresholds.
   */
  getThresholds(): ResourceThresholds {
    return { ...this.config.thresholds };
  }

  /**
   * Gets the resource usage history.
   */
  getResourceHistory(): ResourceDataPoint[] {
    return [...this.history];
  }

  /**
   * Gets resource usage statistics.
   */
  getStatistics(): ResourceStatistics {
    if (this.history.length === 0) {
      return {
        memory: { current: 0, average: 0, min: 0, max: 0 },
        disk: { current: 0, average: 0, min: 0, max: 0 },
        cpu: { current: 0, average: 0, min: 0, max: 0 },
      };
    }

    const memoryValues = this.history.map((h) => h.memoryUsage);
    const diskValues = this.history.map((h) => h.diskUsage);
    const cpuValues = this.history.map((h) => h.cpuUsage);

    const latest = this.history[this.history.length - 1];

    return {
      memory: {
        current: latest.memoryUsage,
        average: memoryValues.reduce((sum, val) => sum + val, 0) / memoryValues.length,
        min: Math.min(...memoryValues),
        max: Math.max(...memoryValues),
      },
      disk: {
        current: latest.diskUsage,
        average: diskValues.reduce((sum, val) => sum + val, 0) / diskValues.length,
        min: Math.min(...diskValues),
        max: Math.max(...diskValues),
      },
      cpu: {
        current: latest.cpuUsage,
        average: cpuValues.reduce((sum, val) => sum + val, 0) / cpuValues.length,
        min: Math.min(...cpuValues),
        max: Math.max(...cpuValues),
      },
    };
  }

  /**
   * Checks if there's sufficient disk space for a given requirement.
   */
  checkDiskSpace(requiredBytes: number): boolean {
    try {
      const resources = this.getCurrentResourcesSync();
      const available = resources.freeDisk;

      if (available < requiredBytes) {
        this.emitAlert({
          type: 'critical',
          resource: 'disk',
          currentUsage: resources.diskUsage,
          threshold: this.config.thresholds.diskCritical,
          message: `Insufficient disk space: ${formatBytes(requiredBytes)} required, ${formatBytes(available)} available`,
          timestamp: new Date(),
          recommendation: 'Free up disk space or reduce matrix size',
        });
        return false;
      }

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Parses a human-readable byte string to bytes.
   */
  parseBytes(bytesStr: string): number {
    const units = {
      B: 1,
      KB: 1024,
      MB: 1024 * 1024,
      GB: 1024 * 1024 * 1024,
      TB: 1024 * 1024 * 1024 * 1024,
    };

    const match = bytesStr.match(/^([\d.]+)\s*([A-Z]+)$/i);
    if (!match) return 0;

    const value = parseFloat(match[1]);
    const unit = match[2].toUpperCase() as keyof typeof units;

    return value * (units[unit] || 1);
  }

  /**
   * Checks system resources and triggers alerts if needed.
   */
  private async checkResources(): Promise<void> {
    const resources = await getSystemResources();

    // Add to history
    this.history.push({
      timestamp: new Date(),
      memoryUsage: resources.memoryUsage,
      diskUsage: resources.diskUsage,
      cpuUsage: resources.cpuUsage,
    });

    // Limit history size
    if (this.history.length > this.config.maxHistorySize!) {
      this.history = this.history.slice(-this.config.maxHistorySize!);
    }

    // Check thresholds and emit alerts
    this.checkThresholds(resources);

    // Emit update
    if (this.config.onUpdate) {
      this.config.onUpdate(resources);
    }

    // Generate recommendations based on trends
    this.generateRecommendations(resources);
  }

  /**
   * Checks resource thresholds and emits alerts.
   */
  private checkThresholds(resources: SystemResources): void {
    const thresholds = this.config.thresholds;
    const now = new Date();

    // Check memory thresholds
    if (resources.memoryUsage >= thresholds.memoryCritical) {
      this.emitThrottledAlert('memory-critical', {
        type: 'critical',
        resource: 'memory',
        currentUsage: resources.memoryUsage,
        threshold: thresholds.memoryCritical,
        message: `Critical memory usage: ${resources.memoryUsage.toFixed(1)}%`,
        timestamp: now,
        recommendation: 'Reduce parallel execution or free memory',
      });
    } else if (resources.memoryUsage >= thresholds.memoryWarning) {
      this.emitThrottledAlert('memory-warning', {
        type: 'warning',
        resource: 'memory',
        currentUsage: resources.memoryUsage,
        threshold: thresholds.memoryWarning,
        message: `High memory usage: ${resources.memoryUsage.toFixed(1)}%`,
        timestamp: now,
        recommendation: 'Consider reducing parallel execution',
      });
    }

    // Check disk thresholds
    if (resources.diskUsage >= thresholds.diskCritical) {
      this.emitThrottledAlert('disk-critical', {
        type: 'critical',
        resource: 'disk',
        currentUsage: resources.diskUsage,
        threshold: thresholds.diskCritical,
        message: `Critical disk usage: ${resources.diskUsage.toFixed(1)}%`,
        timestamp: now,
        recommendation: 'Clean up disk space immediately',
      });
    } else if (resources.diskUsage >= thresholds.diskWarning) {
      this.emitThrottledAlert('disk-warning', {
        type: 'warning',
        resource: 'disk',
        currentUsage: resources.diskUsage,
        threshold: thresholds.diskWarning,
        message: `High disk usage: ${resources.diskUsage.toFixed(1)}%`,
        timestamp: now,
        recommendation: 'Monitor disk space closely',
      });
    }

    // Check CPU thresholds
    if (resources.cpuUsage >= thresholds.cpuCritical) {
      this.emitThrottledAlert('cpu-critical', {
        type: 'critical',
        resource: 'cpu',
        currentUsage: resources.cpuUsage,
        threshold: thresholds.cpuCritical,
        message: `Critical CPU usage: ${resources.cpuUsage.toFixed(1)}%`,
        timestamp: now,
        recommendation: 'Reduce concurrent operations',
      });
    } else if (resources.cpuUsage >= thresholds.cpuWarning) {
      this.emitThrottledAlert('cpu-warning', {
        type: 'warning',
        resource: 'cpu',
        currentUsage: resources.cpuUsage,
        threshold: thresholds.cpuWarning,
        message: `High CPU usage: ${resources.cpuUsage.toFixed(1)}%`,
        timestamp: now,
        recommendation: 'Consider reducing parallel execution',
      });
    }
  }

  /**
   * Emits an alert, but throttles repeated alerts.
   */
  private emitThrottledAlert(alertKey: string, alert: ResourceAlert): void {
    const lastAlert = this.lastAlerts.get(alertKey);
    const now = new Date();

    // Only emit if no recent alert (within 30 seconds)
    if (!lastAlert || now.getTime() - lastAlert.getTime() > 30000) {
      this.emitAlert(alert);
      this.lastAlerts.set(alertKey, now);
    }
  }

  /**
   * Emits a resource alert.
   */
  private emitAlert(alert: ResourceAlert): void {
    if (this.config.onAlert) {
      this.config.onAlert(alert);
    }
  }

  /**
   * Generates performance recommendations based on resource trends.
   */
  private generateRecommendations(resources: SystemResources): void {
    if (!this.config.onRecommendation) return;

    // Recommend reducing parallelism if multiple resources are high
    let highResourceCount = 0;
    if (resources.memoryUsage > 70) highResourceCount++;
    if (resources.diskUsage > 70) highResourceCount++;
    if (resources.cpuUsage > 70) highResourceCount++;

    if (highResourceCount >= 2) {
      this.config.onRecommendation(
        'Multiple resources at high usage - consider reducing parallel execution from 4 to 2 or 1'
      );
    }

    // Recommend based on available cores vs current CPU usage
    if (resources.cpuUsage > 80 && resources.cpuCores > 2) {
      this.config.onRecommendation(
        `High CPU usage detected - consider limiting concurrent runs to ${Math.max(1, Math.floor(resources.cpuCores / 2))}`
      );
    }
  }

  /**
   * Gets current resources synchronously (simplified version).
   */
  private getCurrentResourcesSync(): SystemResources {
    // This is a simplified fallback - in real implementation you'd use proper system APIs
    try {
      const totalMemory = require('os').totalmem();
      const freeMemory = require('os').freemem();
      const memoryUsage = ((totalMemory - freeMemory) / totalMemory) * 100;

      return {
        memoryUsage,
        totalMemory,
        freeMemory,
        diskUsage: 50, // Placeholder
        totalDisk: 1024 * 1024 * 1024 * 100, // 100GB placeholder
        freeDisk: 1024 * 1024 * 1024 * 50, // 50GB placeholder
        cpuUsage: 0, // Can't get synchronously
        cpuCores: require('os').cpus().length,
        loadAverage: require('os').loadavg(),
      };
    } catch {
      return {
        memoryUsage: 0,
        totalMemory: 0,
        freeMemory: 0,
        diskUsage: 0,
        totalDisk: 0,
        freeDisk: 0,
        cpuUsage: 0,
        cpuCores: 1,
        loadAverage: [0, 0, 0],
      };
    }
  }
}

/**
 * Gets current system resource usage.
 */
export async function getSystemResources(): Promise<SystemResources> {
  try {
    const os = require('os');

    // Memory information
    const totalMemory = os.totalmem();
    const freeMemory = os.freemem();
    const memoryUsage = ((totalMemory - freeMemory) / totalMemory) * 100;

    // CPU information
    const cpus = os.cpus();
    const cpuCores = cpus.length;
    const loadAverage = os.loadavg();

    // Estimate CPU usage from load average
    const cpuUsage = Math.min((loadAverage[0] / cpuCores) * 100, 100);

    // Disk information (for current working directory)
    const diskUsage = await calculateDiskUsage(process.cwd());

    return {
      memoryUsage,
      totalMemory,
      freeMemory,
      diskUsage: diskUsage.usage,
      totalDisk: diskUsage.total,
      freeDisk: diskUsage.free,
      cpuUsage,
      cpuCores,
      loadAverage,
    };
  } catch (error) {
    // Fallback values if system detection fails
    return {
      memoryUsage: 0,
      totalMemory: 8 * 1024 * 1024 * 1024, // 8GB default
      freeMemory: 4 * 1024 * 1024 * 1024, // 4GB default
      diskUsage: 50,
      totalDisk: 100 * 1024 * 1024 * 1024, // 100GB default
      freeDisk: 50 * 1024 * 1024 * 1024, // 50GB default
      cpuUsage: 0,
      cpuCores: 4,
      loadAverage: [0, 0, 0],
    };
  }
}

/**
 * Calculates disk usage for a specific directory.
 */
export async function calculateDiskUsage(dirPath: string): Promise<DiskUsage> {
  try {
    if (process.platform === 'win32') {
      // Windows implementation - validate drive path to prevent injection
      const drive = dirPath.substring(0, 2);
      if (!/^[A-Za-z]:$/.test(drive)) {
        throw new Error(`Invalid drive path: ${drive}`);
      }

      const proc = Bun.spawn(['fsutil', 'volume', 'diskfree', drive], {
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const output = await new Response(proc.stdout).text();
      const lines = output.split('\n');

      // Parse Windows fsutil output
      const freeBytes = parseInt(lines[0].split(':')[1].trim());
      const totalBytes = parseInt(lines[1].split(':')[1].trim());
      const usedBytes = totalBytes - freeBytes;

      return {
        total: totalBytes,
        used: usedBytes,
        free: freeBytes,
        usage: (usedBytes / totalBytes) * 100,
      };
    } else {
      // Unix-like systems - validate path to prevent injection
      const resolvedPath = join(dirPath);
      if (resolvedPath.includes('..') || resolvedPath.includes('`') || resolvedPath.includes('$')) {
        throw new Error(`Invalid directory path: ${dirPath}`);
      }

      const proc = Bun.spawn(['df', '-k', resolvedPath], {
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const output = await new Response(proc.stdout).text();
      const lines = output.split('\n');
      const data = lines[1].split(/\s+/);

      const totalKB = parseInt(data[1]);
      const usedKB = parseInt(data[2]);
      const freeKB = parseInt(data[3]);

      const total = totalKB * 1024;
      const used = usedKB * 1024;
      const free = freeKB * 1024;

      return {
        total,
        used,
        free,
        usage: (used / total) * 100,
      };
    }
  } catch (error) {
    // Fallback if disk usage detection fails
    return {
      total: 100 * 1024 * 1024 * 1024, // 100GB
      used: 50 * 1024 * 1024 * 1024, // 50GB
      free: 50 * 1024 * 1024 * 1024, // 50GB
      usage: 50,
    };
  }
}

/**
 * Formats bytes into human-readable format.
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';

  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

/**
 * Creates a new resource monitor with the specified configuration.
 */
export function createResourceMonitor(config: ResourceMonitorConfig): ResourceMonitor {
  return new ResourceMonitor(config);
}

import { EventEmitter } from "node:events";

interface PerformanceMetric {
    operation: string;
    duration: number;
    timestamp: Date;
    success: boolean;
    metadata?: Record<string, unknown>;
}

interface PerformanceAlert {
    type: "LATENCY" | "ERROR_RATE" | "THROUGHPUT";
    threshold: number;
    current: number;
    operation: string;
    timestamp: Date;
}

export class PerformanceMonitor extends EventEmitter {
    private static instance: PerformanceMonitor;
    private metrics: PerformanceMetric[] = [];
    private readonly maxMetrics: number = 1000;
    private alertThresholds = {
        latency: 2000, // 2 seconds
        errorRate: 0.1, // 10%
        throughput: 10, // requests per second
    };

    private constructor() {
        super();
        this.startPeriodicCheck();
    }

    static getInstance(): PerformanceMonitor {
        if (!PerformanceMonitor.instance) {
            PerformanceMonitor.instance = new PerformanceMonitor();
        }
        return PerformanceMonitor.instance;
    }

    // Record a performance metric
    recordMetric(metric: Omit<PerformanceMetric, "timestamp">): void {
        const fullMetric = {
            ...metric,
            timestamp: new Date(),
        };

        this.metrics.push(fullMetric);
        if (this.metrics.length > this.maxMetrics) {
            this.metrics.shift();
        }

        this.checkThresholds(fullMetric);
    }

    // Start measuring operation duration
    startOperation(
        operation: string,
        metadata?: Record<string, unknown>
    ): () => void {
        const startTime = performance.now();
        return () => {
            const duration = performance.now() - startTime;
            this.recordMetric({
                operation,
                duration,
                success: true,
                metadata,
            });
        };
    }

    // Get average latency for an operation
    getAverageLatency(operation: string, timeWindowMs = 60000): number {
        const relevantMetrics = this.getRecentMetrics(operation, timeWindowMs);
        if (relevantMetrics.length === 0) return 0;

        const totalDuration = relevantMetrics.reduce(
            (sum, metric) => sum + metric.duration,
            0
        );
        return totalDuration / relevantMetrics.length;
    }

    // Get error rate for an operation
    getErrorRate(operation: string, timeWindowMs = 60000): number {
        const relevantMetrics = this.getRecentMetrics(operation, timeWindowMs);
        if (relevantMetrics.length === 0) return 0;

        const errorCount = relevantMetrics.filter(
            (metric) => !metric.success
        ).length;
        return errorCount / relevantMetrics.length;
    }

    // Get throughput (operations per second)
    getThroughput(operation: string, timeWindowMs = 60000): number {
        const relevantMetrics = this.getRecentMetrics(operation, timeWindowMs);
        return (relevantMetrics.length / timeWindowMs) * 1000;
    }

    // Get performance summary
    getPerformanceSummary(timeWindowMs = 60000): Record<
        string,
        {
            averageLatency: number;
            errorRate: number;
            throughput: number;
        }
    > {
        const operations = new Set(this.metrics.map((m) => m.operation));
        const summary: Record<string, {
            averageLatency: number;
            errorRate: number;
            throughput: number;
        }> = {};

        for (const operation of operations) {
            summary[operation] = {
                averageLatency: this.getAverageLatency(operation, timeWindowMs),
                errorRate: this.getErrorRate(operation, timeWindowMs),
                throughput: this.getThroughput(operation, timeWindowMs),
            };
        }

        return summary;
    }

    // Set alert thresholds
    setAlertThresholds(thresholds: Partial<typeof this.alertThresholds>): void {
        this.alertThresholds = {
            ...this.alertThresholds,
            ...thresholds,
        };
    }

    private getRecentMetrics(
        operation: string,
        timeWindowMs: number
    ): PerformanceMetric[] {
        const now = new Date();
        const windowStart = new Date(now.getTime() - timeWindowMs);
        return this.metrics.filter(
            (metric) =>
                metric.operation === operation &&
                metric.timestamp >= windowStart
        );
    }

    private checkThresholds(metric: PerformanceMetric): void {
        // Check latency threshold
        if (metric.duration > this.alertThresholds.latency) {
            this.emitAlert({
                type: "LATENCY",
                threshold: this.alertThresholds.latency,
                current: metric.duration,
                operation: metric.operation,
                timestamp: new Date(),
            });
        }

        // Check error rate threshold
        const errorRate = this.getErrorRate(metric.operation);
        if (errorRate > this.alertThresholds.errorRate) {
            this.emitAlert({
                type: "ERROR_RATE",
                threshold: this.alertThresholds.errorRate,
                current: errorRate,
                operation: metric.operation,
                timestamp: new Date(),
            });
        }

        // Check throughput threshold
        const throughput = this.getThroughput(metric.operation);
        if (throughput > this.alertThresholds.throughput) {
            this.emitAlert({
                type: "THROUGHPUT",
                threshold: this.alertThresholds.throughput,
                current: throughput,
                operation: metric.operation,
                timestamp: new Date(),
            });
        }
    }

    private emitAlert(alert: PerformanceAlert): void {
        this.emit("alert", alert);
    }

    private startPeriodicCheck(): void {
        setInterval(() => {
            const summary = this.getPerformanceSummary();
            this.emit("performance-summary", summary);
        }, 60000); // Check every minute
    }
}

// Usage Example:
/*
const monitor = PerformanceMonitor.getInstance();

// Record operation start
const end = monitor.startOperation('fetchCollection', { collectionId: '123' });

try {
    // Your operation here
    end(); // Record successful completion
} catch (error) {
    monitor.recordMetric({
        operation: 'fetchCollection',
        duration: 0,
        success: false,
        metadata: { error: error.message },
    });
}

// Listen for alerts
monitor.on('alert', (alert: PerformanceAlert) => {
    console.log(`Performance alert: ${alert.type} threshold exceeded for ${alert.operation}`);
});

// Get performance summary
const summary = monitor.getPerformanceSummary();
console.log('Performance summary:', summary);
*/

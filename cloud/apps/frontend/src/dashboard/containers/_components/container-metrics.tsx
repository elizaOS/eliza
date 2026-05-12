/**
 * Container metrics component displaying real-time container performance metrics.
 * Shows CPU, memory, network utilization, and task health with auto-refresh support.
 *
 * @param props - Container metrics configuration
 * @param props.containerId - Container ID to fetch metrics for
 * @param props.containerName - Container name for display
 */

"use client";

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Skeleton,
} from "@elizaos/cloud-ui";
import { Activity, Cpu, HardDrive, Network, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

interface ContainerMetrics {
  cpu_utilization: number;
  memory_utilization: number;
  network_rx_bytes: number;
  network_tx_bytes: number;
  task_count: number;
  healthy_task_count: number;
  timestamp: string;
}

interface ContainerMetricsProps {
  containerId: string;
  containerName: string;
}

type UtilizationBadgeVariant = "default" | "secondary" | "destructive";

const METRICS_REFRESH_MS = 10_000;

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / k ** i).toFixed(2)} ${sizes[i]}`;
}

function getUtilizationColor(utilization: number): string {
  if (utilization >= 80) return "text-red-500";
  if (utilization >= 60) return "text-yellow-500";
  return "text-green-500";
}

function getUtilizationBadge(utilization: number): UtilizationBadgeVariant {
  if (utilization >= 80) return "destructive";
  if (utilization >= 60) return "default";
  return "secondary";
}

export function ContainerMetrics({ containerId, containerName }: ContainerMetricsProps) {
  const [metrics, setMetrics] = useState<ContainerMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);

  const fetchMetrics = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/v1/containers/${containerId}/metrics?period=60`);

      if (!response.ok) {
        throw new Error("Failed to fetch metrics");
      }

      const data = await response.json();
      if (data.success) {
        setMetrics(data.data.metrics);
        setError(null);
      } else {
        setError(data.error || "Failed to load metrics");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch metrics");
    } finally {
      setLoading(false);
    }
  }, [containerId]);

  useEffect(() => {
    void fetchMetrics();
  }, [fetchMetrics]);

  useEffect(() => {
    if (autoRefresh) {
      const interval = setInterval(fetchMetrics, METRICS_REFRESH_MS);
      return () => clearInterval(interval);
    }
  }, [autoRefresh, fetchMetrics]);

  if (loading && !metrics) {
    return (
      <Card className="shadow-lg shadow-black/50">
        <CardHeader>
          <CardTitle>Container Metrics</CardTitle>
          <CardDescription>Loading performance data...</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-24" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="shadow-lg shadow-black/50">
        <CardHeader>
          <CardTitle>Container Metrics</CardTitle>
          <CardDescription className="text-red-500">{error}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center p-8 text-muted-foreground">
            <p>Metrics not available. Container may not be deployed yet.</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!metrics) return null;
  const healthyTaskPercent =
    metrics.task_count > 0 ? (metrics.healthy_task_count / metrics.task_count) * 100 : 0;

  return (
    <Card className="shadow-lg shadow-black/50">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Activity className="h-5 w-5" />
              Container Metrics
            </CardTitle>
            <CardDescription>Real-time performance metrics for {containerName}</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant={autoRefresh ? "default" : "outline"}
              size="sm"
              onClick={() => setAutoRefresh((current) => !current)}
              title="Toggle auto-refresh"
            >
              <RefreshCw className={`h-4 w-4 ${autoRefresh ? "animate-spin" : ""}`} />
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={fetchMetrics}
              disabled={loading}
              title="Refresh metrics"
            >
              Refresh
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {/* CPU Utilization */}
          <div className="p-4 rounded-lg border bg-gradient-to-br from-background to-muted/20 hover:shadow-md transition-shadow">
            <div className="flex items-center justify-between mb-3">
              <div className="p-2 rounded-md bg-blue-500/10">
                <Cpu className="h-4 w-4 text-blue-500" />
              </div>
              <Badge variant={getUtilizationBadge(metrics.cpu_utilization)} className="text-xs">
                {metrics.cpu_utilization.toFixed(1)}%
              </Badge>
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium text-muted-foreground">CPU Usage</p>
              <p className={`text-3xl font-bold ${getUtilizationColor(metrics.cpu_utilization)}`}>
                {metrics.cpu_utilization.toFixed(1)}%
              </p>
            </div>
            {/* Progress bar */}
            <div className="mt-3 h-2 bg-muted rounded-full overflow-hidden">
              <div
                className={`h-full transition-all duration-500 ${getUtilizationColor(metrics.cpu_utilization).replace("text-", "bg-")}`}
                style={{ width: `${Math.min(metrics.cpu_utilization, 100)}%` }}
              />
            </div>
          </div>

          {/* Memory Utilization */}
          <div className="p-4 rounded-lg border bg-gradient-to-br from-background to-muted/20 hover:shadow-md transition-shadow">
            <div className="flex items-center justify-between mb-3">
              <div className="p-2 rounded-md bg-purple-500/10">
                <HardDrive className="h-4 w-4 text-purple-500" />
              </div>
              <Badge variant={getUtilizationBadge(metrics.memory_utilization)} className="text-xs">
                {metrics.memory_utilization.toFixed(1)}%
              </Badge>
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium text-muted-foreground">Memory Usage</p>
              <p
                className={`text-3xl font-bold ${getUtilizationColor(metrics.memory_utilization)}`}
              >
                {metrics.memory_utilization.toFixed(1)}%
              </p>
            </div>
            {/* Progress bar */}
            <div className="mt-3 h-2 bg-muted rounded-full overflow-hidden">
              <div
                className={`h-full transition-all duration-500 ${getUtilizationColor(metrics.memory_utilization).replace("text-", "bg-")}`}
                style={{
                  width: `${Math.min(metrics.memory_utilization, 100)}%`,
                }}
              />
            </div>
          </div>

          {/* Network In */}
          <div className="p-4 rounded-lg border bg-gradient-to-br from-background to-muted/20 hover:shadow-md transition-shadow">
            <div className="flex items-center justify-between mb-3">
              <div className="p-2 rounded-md bg-emerald-500/10">
                <Network className="h-4 w-4 text-emerald-500" />
              </div>
              <Badge variant="outline" className="text-xs">
                RX
              </Badge>
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium text-muted-foreground">Network In</p>
              <p className="text-3xl font-bold text-emerald-500">
                {formatBytes(metrics.network_rx_bytes)}
              </p>
            </div>
          </div>

          {/* Network Out */}
          <div className="p-4 rounded-lg border bg-gradient-to-br from-background to-muted/20 hover:shadow-md transition-shadow">
            <div className="flex items-center justify-between mb-3">
              <div className="p-2 rounded-md bg-amber-500/10">
                <Network className="h-4 w-4 text-amber-500" />
              </div>
              <Badge variant="outline" className="text-xs">
                TX
              </Badge>
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium text-muted-foreground">Network Out</p>
              <p className="text-3xl font-bold text-amber-500">
                {formatBytes(metrics.network_tx_bytes)}
              </p>
            </div>
          </div>
        </div>

        {/* Task Status */}
        <div className="mt-6 p-4 bg-muted/50 rounded-lg border">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-md bg-green-500/10">
                <Activity className="h-4 w-4 text-green-500" />
              </div>
              <div>
                <p className="text-sm font-medium">Task Health Status</p>
                <p className="text-xs text-muted-foreground">
                  {metrics.healthy_task_count === metrics.task_count
                    ? "All tasks running healthy"
                    : `${metrics.task_count - metrics.healthy_task_count} task(s) unhealthy`}
                </p>
              </div>
            </div>
            <div className="text-right">
              <div className="flex items-center gap-2">
                <span className="text-2xl font-bold text-green-500">
                  {metrics.healthy_task_count}
                </span>
                <span className="text-lg text-muted-foreground">/ {metrics.task_count}</span>
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                {healthyTaskPercent.toFixed(0)}% healthy
              </p>
            </div>
          </div>
          <div className="mt-3 h-2 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-green-500 transition-all duration-500"
              style={{
                width: `${healthyTaskPercent}%`,
              }}
            />
          </div>
          <p className="text-xs text-muted-foreground mt-3 text-center">
            Last updated: {new Date(metrics.timestamp).toLocaleString()}
          </p>
        </div>

        {autoRefresh && (
          <div className="flex items-center justify-center gap-2 mt-4 text-xs text-green-600 dark:text-green-400">
            <RefreshCw className="h-3 w-3 animate-spin" />
            <span>Auto-refreshing every 10 seconds</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

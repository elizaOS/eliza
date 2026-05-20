/**
 * Training Dashboard Admin Panel
 *
 * @description Complete monitoring and control interface for the RL training system.
 * Provides real-time status updates, training readiness checks, job management,
 * and system health monitoring. Allows admins to trigger training jobs and view
 * training metrics.
 *
 * @page /admin/training
 * @access Admin only
 *
 * @features
 * - Real-time training status updates (refreshes every 5 seconds)
 * - Data collection statistics (24h, 7d, rate per hour)
 * - Training readiness checks (trajectories, scenario groups, data quality)
 * - Current model version tracking
 * - Training job management
 * - System health monitoring (database, storage, W&B)
 * - Manual training trigger
 * - W&B integration links
 *
 * @example
 * ```tsx
 * // Accessible at /admin/training
 * // Requires admin privileges
 * <TrainingDashboard />
 * ```
 */

"use client";

import { logger } from "@feed/shared";
import {
  AlertCircle,
  Cpu,
  Database,
  Loader2,
  PlayCircle,
  TrendingUp,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { apiUrl } from "@/utils/api-url";

/**
 * Training job information
 */
interface TrainingJob {
  id: string;
  modelVersion: string;
  status: string;
  createdAt: string | Date;
}

/**
 * Training model information
 */
interface TrainingModel {
  id: string;
  version: string;
  status: string;
}

/**
 * Complete training system status
 */
interface TrainingStatus {
  status: string;
  automation: {
    dataCollection: {
      last24h: number;
      last7d: number;
      ratePerHour: number;
    };
    training: {
      currentJob: string | null;
      lastCompleted: Date | null;
      nextScheduled: Date | null;
    };
    models: {
      latest: string | null;
      deployed: number;
      training: number;
    };
    health: {
      database: boolean;
      storage: boolean;
    };
  };
  readiness: {
    ready: boolean;
    reason: string;
    stats: {
      totalTrajectories: number;
      unscoredTrajectories: number;
      scenarioGroups: number;
      dataQuality: number;
    };
  };
  recentJobs: TrainingJob[];
  models: TrainingModel[];
  trajectoryStats: {
    last1h?: number;
    last24h?: number;
    last7d?: number;
  };
}

/**
 * Training Dashboard Component
 *
 * @description Main component for the RL training dashboard admin panel.
 * Displays training status, readiness metrics, job history, and system health.
 * Allows admins to trigger training jobs manually.
 *
 * @returns {JSX.Element} Training dashboard page
 */
export default function TrainingDashboard() {
  const [status, setStatus] = useState<TrainingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [training, setTraining] = useState(false);

  const loadStatus = useCallback(async () => {
    const res = await fetch(apiUrl("/api/admin/training/status"));

    if (!res.ok) {
      logger.error(
        "Failed to load training status",
        undefined,
        "TrainingAdmin",
      );
      setLoading(false);
      return;
    }

    const data = await res.json();
    setStatus(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    loadStatus();
    const interval = setInterval(loadStatus, 5000); // Refresh every 5s
    return () => clearInterval(interval);
  }, [loadStatus]);

  async function triggerTraining() {
    setTraining(true);

    const res = await fetch(apiUrl("/api/admin/training/trigger"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force: false }),
    });

    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      setTraining(false);
      alert(`Error: ${errorData.error || "Failed to trigger training"}`);
      return;
    }

    const result = await res.json();

    if (result.success) {
      alert(`Training started! Job ID: ${result.jobId}`);
      await loadStatus();
    } else {
      alert(`Failed to start training: ${result.error || "Unknown error"}`);
    }
    setTraining(false);
  }

  if (loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center md:min-h-screen">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }

  if (!status) {
    return (
      <div className="p-8">
        <div className="text-red-500">Failed to load training status</div>
      </div>
    );
  }

  const { automation, readiness } = status;

  return (
    <div className="space-y-6 p-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-bold text-3xl">RL Training Dashboard</h1>
          <p className="text-muted-foreground">
            Monitor and control automated training pipeline
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            onClick={triggerTraining}
            disabled={training || !!automation.training.currentJob}
            size="lg"
          >
            {training ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Starting...
              </>
            ) : (
              <>
                <PlayCircle className="mr-2 h-4 w-4" />
                Train Now
              </>
            )}
          </Button>
        </div>
      </div>

      {/* Data Collection Stats */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="font-medium text-sm">
              Trajectories (24h)
            </CardTitle>
            <Database className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="font-bold text-2xl">
              {automation.dataCollection.last24h}
            </div>
            <p className="text-muted-foreground text-xs">
              {automation.dataCollection.ratePerHour.toFixed(1)}/hour
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="font-medium text-sm">
              Ready for Training
            </CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="font-bold text-2xl">
              {readiness.stats.totalTrajectories}
            </div>
            <p className="text-muted-foreground text-xs">
              {readiness.stats.scenarioGroups} scenario groups
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="font-medium text-sm">Current Model</CardTitle>
            <Cpu className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="font-bold text-2xl">
              {automation.models.latest || "None"}
            </div>
            <p className="text-muted-foreground text-xs">
              {automation.models.deployed} deployed
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="font-medium text-sm">Data Quality</CardTitle>
            <AlertCircle className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="font-bold text-2xl">
              {(readiness.stats.dataQuality * 100).toFixed(0)}%
            </div>
            <p className="text-muted-foreground text-xs">
              {readiness.ready ? "✅ Ready" : "⏳ Collecting"}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Training Readiness */}
      <Card>
        <CardHeader>
          <CardTitle>Training Readiness</CardTitle>
          <CardDescription>
            {readiness.ready ? "✅ Ready to train!" : `⏳ ${readiness.reason}`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <div className="flex justify-between">
              <span>Trajectories:</span>
              <Badge
                variant={
                  readiness.stats.totalTrajectories >= 100
                    ? "default"
                    : "secondary"
                }
              >
                {readiness.stats.totalTrajectories} / 100
              </Badge>
            </div>
            <div className="flex justify-between">
              <span>Scenario Groups:</span>
              <Badge
                variant={
                  readiness.stats.scenarioGroups >= 10 ? "default" : "secondary"
                }
              >
                {readiness.stats.scenarioGroups} / 10
              </Badge>
            </div>
            <div className="flex justify-between">
              <span>Data Quality:</span>
              <Badge
                variant={
                  readiness.stats.dataQuality >= 0.95 ? "default" : "secondary"
                }
              >
                {(readiness.stats.dataQuality * 100).toFixed(1)}% / 95%
              </Badge>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Training Status */}
      {automation.training.currentJob && (
        <Card>
          <CardHeader>
            <CardTitle>Training In Progress</CardTitle>
            <CardDescription>
              Job ID: {automation.training.currentJob}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <div className="h-2 w-full rounded-full bg-secondary">
                <div
                  className="h-2 rounded-full bg-primary transition-all duration-500"
                  style={{ width: "50%" }}
                />
              </div>
              <p className="text-muted-foreground text-sm">ETA: ~30 minutes</p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Recent Jobs */}
      <Card>
        <CardHeader>
          <CardTitle>Recent Training Jobs</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {status.recentJobs.map((job: TrainingJob) => (
              <div
                key={job.id}
                className="flex items-center justify-between rounded border p-2"
              >
                <div>
                  <div className="font-medium">{job.modelVersion}</div>
                  <div className="text-muted-foreground text-sm">
                    {new Date(job.createdAt).toLocaleString()}
                  </div>
                </div>
                <Badge
                  variant={
                    job.status === "completed"
                      ? "default"
                      : job.status === "training"
                        ? "secondary"
                        : job.status === "failed"
                          ? "destructive"
                          : "outline"
                  }
                >
                  {job.status}
                </Badge>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* System Health */}
      <Card>
        <CardHeader>
          <CardTitle>System Health</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <div className="flex justify-between">
              <span>Database:</span>
              <Badge
                variant={automation.health.database ? "default" : "destructive"}
              >
                {automation.health.database ? "✅ Healthy" : "❌ Error"}
              </Badge>
            </div>
            <div className="flex justify-between">
              <span>Storage:</span>
              <Badge
                variant={automation.health.storage ? "default" : "destructive"}
              >
                {automation.health.storage ? "✅ Healthy" : "❌ Error"}
              </Badge>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

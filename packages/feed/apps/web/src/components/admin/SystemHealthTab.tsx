/**
 * System Health tab component for monitoring platform health.
 *
 * Uses the shared system status snapshot from `/api/admin/stats/system` so the
 * dashboard and cron alerting describe the same subsystem state.
 */
'use client';

import { cn } from '@feed/shared';
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  CheckCircle,
  Clock3,
  Cpu,
  Database,
  HardDrive,
  Layers3,
  MessageSquare,
  Radio,
  RefreshCw,
  Server,
  Timer,
  Zap,
} from 'lucide-react';
import { useCallback, useEffect, useState, useTransition } from 'react';
import { Skeleton } from '@/components/shared/Skeleton';
import { apiUrl } from '@/utils/api-url';

type SystemStatusLevel = 'healthy' | 'warning' | 'critical';

type SubsystemKey =
  | 'database'
  | 'redis'
  | 'game-engine'
  | 'cron'
  | 'realtime'
  | 'content'
  | 'llm'
  | 'query-performance'
  | 'memory';

interface SystemStatusData {
  status: SystemStatusLevel;
  issues: string[];
  criticalIssues: string[];
  timestamp: string;
  summary: {
    total: number;
    healthyCount: number;
    warningCount: number;
    criticalCount: number;
  };
  subsystems: Array<{
    key: SubsystemKey;
    label: string;
    status: SystemStatusLevel;
    summary: string;
    details: string;
    metric?: {
      label: string;
      value: string;
    };
  }>;
  gameEngine: {
    isRunning: boolean;
    currentDay: number;
    lastTickAt: string | null;
    timeSinceLastTickMs: number | null;
    tickIntervalMs: number;
    uptimeMs: number;
  };
  activityMetrics: {
    lastHour: {
      newUsers: number;
      newPosts: number;
    };
    last24Hours: {
      newUsers: number;
      newPosts: number;
    };
  };
  cronJobs: {
    alerts: Array<{
      jobName: string;
      message: string;
      severity: 'warning' | 'critical';
    }>;
    gameTick: CronJob | null;
    agentTick: CronJob | null;
    realtimeDrain: CronJob | null;
  };
  llm: {
    callsLast24h: number;
    errorsLastHour: number;
  };
  realtime: {
    outboxPending: number;
    outboxLagSeconds: number;
  };
  performance: {
    query: {
      p95DurationMs: number;
      slowRate: number;
    };
    memory: {
      usagePercent: number;
    };
  };
}

interface CronJob {
  jobName: string;
  consecutiveFailures: number;
  lastExecution: string | null;
  lastSuccess: string | null;
}

const subsystemIcons: Record<
  SubsystemKey,
  React.ComponentType<{ className?: string }>
> = {
  database: Database,
  redis: Layers3,
  'game-engine': Zap,
  cron: Clock3,
  realtime: Radio,
  content: MessageSquare,
  llm: Activity,
  'query-performance': Timer,
  memory: Cpu,
};

function formatTimeSince(ms: number | null) {
  if (ms === null) return 'Never';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

function formatTimeFromIso(value: string | null) {
  if (!value) return 'Never';
  return formatTimeSince(Date.now() - new Date(value).getTime());
}

function formatUptime(ms: number) {
  const hours = Math.floor(ms / (60 * 60 * 1000));
  const minutes = Math.floor((ms % (60 * 60 * 1000)) / (60 * 1000));

  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
  }

  return `${hours}h ${minutes}m`;
}

function getStatusContainerClass(status: SystemStatusLevel) {
  switch (status) {
    case 'healthy':
      return 'border-green-500/20 bg-green-500/10 text-green-600';
    case 'warning':
      return 'border-amber-500/20 bg-amber-500/10 text-amber-600';
    case 'critical':
      return 'border-red-500/20 bg-red-500/10 text-red-600';
  }
}

function getStatusDotClass(status: SystemStatusLevel) {
  switch (status) {
    case 'healthy':
      return 'bg-green-500';
    case 'warning':
      return 'bg-amber-500';
    case 'critical':
      return 'bg-red-500';
  }
}

function getStatusIcon(status: SystemStatusLevel) {
  switch (status) {
    case 'healthy':
      return <CheckCircle className="h-6 w-6 text-green-500" />;
    case 'warning':
      return <AlertTriangle className="h-6 w-6 text-amber-500" />;
    case 'critical':
      return <AlertCircle className="h-6 w-6 text-red-500" />;
  }
}

function MetricCard({
  icon: Icon,
  label,
  value,
  subValue,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  subValue?: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="rounded-lg bg-muted p-2">
          <Icon className="h-4 w-4 text-muted-foreground" />
        </div>
      </div>
      <div className="font-semibold text-2xl">{value}</div>
      <div className="mt-1 text-muted-foreground text-sm">{label}</div>
      {subValue ? (
        <div className="mt-1 text-muted-foreground text-xs">{subValue}</div>
      ) : null}
    </div>
  );
}

function SubsystemCard({
  subsystem,
}: {
  subsystem: SystemStatusData['subsystems'][number];
}) {
  const Icon = subsystemIcons[subsystem.key] ?? Server;

  return (
    <div className="rounded-xl border border-border bg-card p-4 sm:p-5">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="rounded-lg bg-muted p-2">
            <Icon className="h-4 w-4 text-muted-foreground" />
          </div>
          <div>
            <div className="font-semibold text-base">{subsystem.label}</div>
            <div className="mt-1 text-muted-foreground text-sm">
              {subsystem.summary}
            </div>
          </div>
        </div>
        <div
          className={cn(
            'flex items-center gap-2 rounded-full border px-2.5 py-1 font-medium text-xs capitalize',
            getStatusContainerClass(subsystem.status)
          )}
        >
          <div
            className={cn(
              'h-2 w-2 rounded-full',
              getStatusDotClass(subsystem.status)
            )}
          />
          {subsystem.status}
        </div>
      </div>

      <div className="min-h-[40px] text-muted-foreground text-sm">
        {subsystem.details}
      </div>

      {subsystem.metric ? (
        <div className="mt-4 rounded-lg bg-muted/50 px-3 py-2">
          <div className="text-[11px] text-muted-foreground uppercase tracking-wide">
            {subsystem.metric.label}
          </div>
          <div className="font-medium text-sm">{subsystem.metric.value}</div>
        </div>
      ) : null}
    </div>
  );
}

function CronJobRow({ job }: { job: CronJob | null }) {
  if (!job) {
    return (
      <div className="rounded-lg bg-muted/40 px-3 py-2 text-muted-foreground text-sm">
        No data yet
      </div>
    );
  }

  const status: SystemStatusLevel =
    job.consecutiveFailures >= 5
      ? 'critical'
      : job.consecutiveFailures >= 3
        ? 'warning'
        : 'healthy';

  return (
    <div className="rounded-lg bg-muted/40 px-3 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="font-medium text-sm">{job.jobName}</div>
        <div
          className={cn(
            'flex items-center gap-2 rounded-full border px-2 py-1 text-[11px] capitalize',
            getStatusContainerClass(status)
          )}
        >
          <div
            className={cn('h-2 w-2 rounded-full', getStatusDotClass(status))}
          />
          {status}
        </div>
      </div>
      <div className="mt-2 text-muted-foreground text-xs">
        Last execution {formatTimeFromIso(job.lastExecution)}
      </div>
      <div className="text-muted-foreground text-xs">
        Last success {formatTimeFromIso(job.lastSuccess)}
      </div>
    </div>
  );
}

export function SystemHealthTab() {
  const [data, setData] = useState<SystemStatusData | null>(null);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, startRefresh] = useTransition();
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const fetchHealth = useCallback((showRefreshing = false) => {
    const runFetch = async () => {
      const response = await fetch(apiUrl('/api/admin/stats/system'));

      if (!response.ok) {
        setLoading(false);
        return;
      }

      const result: SystemStatusData = await response.json();
      setData(result);
      setLastUpdated(new Date());
      setLoading(false);
    };

    if (showRefreshing) {
      startRefresh(() => {
        void runFetch();
      });
      return;
    }

    void runFetch();
  }, []);

  useEffect(() => {
    fetchHealth();
  }, [fetchHealth]);

  useEffect(() => {
    const interval = setInterval(() => fetchHealth(), 30_000);
    return () => clearInterval(interval);
  }, [fetchHealth]);

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-24" />
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} className="h-44" />
          ))}
        </div>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-28" />
          ))}
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="py-12 text-center text-muted-foreground">
        <Server className="mx-auto mb-3 h-12 w-12 opacity-50" />
        <p>Failed to load system health data</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <div
            className={cn(
              'rounded-xl border p-4',
              getStatusContainerClass(data.status)
            )}
          >
            {getStatusIcon(data.status)}
          </div>
          <div>
            <h2 className="font-bold text-2xl capitalize">
              System {data.status}
            </h2>
            <p className="text-muted-foreground">
              {data.summary.criticalCount > 0
                ? `${data.summary.criticalCount} critical subsystem${data.summary.criticalCount === 1 ? '' : 's'}`
                : data.summary.warningCount > 0
                  ? `${data.summary.warningCount} warning subsystem${data.summary.warningCount === 1 ? '' : 's'}`
                  : 'All tracked subsystems are healthy'}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {lastUpdated ? (
            <span className="text-muted-foreground text-sm">
              Updated {formatTimeSince(Date.now() - lastUpdated.getTime())}
            </span>
          ) : null}
          <button
            onClick={() => fetchHealth(true)}
            disabled={isRefreshing}
            className="flex items-center gap-2 rounded-lg bg-muted px-3 py-2 font-medium text-sm transition-colors hover:bg-muted/80 disabled:opacity-50"
          >
            <RefreshCw
              className={cn('h-4 w-4', isRefreshing && 'animate-spin')}
            />
            Refresh
          </button>
        </div>
      </div>

      {data.issues.length > 0 ? (
        <div
          className={cn(
            'rounded-xl border p-4',
            data.status === 'critical'
              ? 'border-red-500/20 bg-red-500/10'
              : 'border-amber-500/20 bg-amber-500/10'
          )}
        >
          <div className="mb-2 flex items-center gap-2 font-semibold">
            <AlertTriangle
              className={cn(
                'h-5 w-5',
                data.status === 'critical' ? 'text-red-500' : 'text-amber-500'
              )}
            />
            Active Issues
          </div>
          <ul className="space-y-1 text-sm">
            {data.issues.map((issue) => (
              <li key={issue} className="text-muted-foreground">
                {issue}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {data.subsystems.map((subsystem) => (
          <SubsystemCard key={subsystem.key} subsystem={subsystem} />
        ))}
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          icon={Zap}
          label="Game tick"
          value={data.gameEngine.isRunning ? 'Running' : 'Paused'}
          subValue={`Day ${data.gameEngine.currentDay} · last tick ${formatTimeSince(
            data.gameEngine.timeSinceLastTickMs
          )}`}
        />
        <MetricCard
          icon={Database}
          label="Query latency"
          value={`${data.performance.query.p95DurationMs}ms`}
          subValue={`${data.performance.query.slowRate}% slow queries in the last minute`}
        />
        <MetricCard
          icon={HardDrive}
          label="Heap usage"
          value={`${data.performance.memory.usagePercent}%`}
          subValue={`${data.realtime.outboxPending} pending realtime events`}
        />
        <MetricCard
          icon={Activity}
          label="LLM errors"
          value={String(data.llm.errorsLastHour)}
          subValue={`${data.llm.callsLast24h.toLocaleString()} calls in the last 24h`}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-border bg-card p-4 sm:p-6">
          <h3 className="mb-4 flex items-center gap-2 font-semibold text-lg">
            <Clock3 className="h-5 w-5 text-blue-500" />
            Recent Activity
          </h3>
          <div className="grid gap-4 sm:grid-cols-2">
            <MetricCard
              icon={Activity}
              label="New users (1h)"
              value={data.activityMetrics.lastHour.newUsers.toLocaleString()}
              subValue={`${data.activityMetrics.lastHour.newPosts.toLocaleString()} new posts`}
            />
            <MetricCard
              icon={MessageSquare}
              label="New users (24h)"
              value={data.activityMetrics.last24Hours.newUsers.toLocaleString()}
              subValue={`${data.activityMetrics.last24Hours.newPosts.toLocaleString()} new posts`}
            />
          </div>
        </div>

        <div className="rounded-xl border border-border bg-card p-4 sm:p-6">
          <h3 className="mb-4 flex items-center gap-2 font-semibold text-lg">
            <Clock3 className="h-5 w-5 text-amber-500" />
            Core Cron Jobs
          </h3>
          <div className="grid gap-3">
            <CronJobRow job={data.cronJobs.gameTick} />
            <CronJobRow job={data.cronJobs.agentTick} />
            <CronJobRow job={data.cronJobs.realtimeDrain} />
          </div>
        </div>
      </div>

      {data.cronJobs.alerts.length > 0 ? (
        <div className="rounded-xl border border-border bg-card p-4 sm:p-6">
          <h3 className="mb-4 flex items-center gap-2 font-semibold text-lg">
            <AlertTriangle className="h-5 w-5 text-amber-500" />
            Cron Alerts
          </h3>
          <div className="space-y-3">
            {data.cronJobs.alerts.map((alert, index) => (
              <div
                key={`${alert.jobName}-${alert.message}-${index}`}
                className={cn(
                  'rounded-lg border px-4 py-3',
                  alert.severity === 'critical'
                    ? 'border-red-500/20 bg-red-500/10'
                    : 'border-amber-500/20 bg-amber-500/10'
                )}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-sm">{alert.jobName}</span>
                  <span
                    className={cn(
                      'rounded-full px-2 py-0.5 text-[11px] uppercase tracking-wide',
                      alert.severity === 'critical'
                        ? 'bg-red-500/15 text-red-600'
                        : 'bg-amber-500/15 text-amber-600'
                    )}
                  >
                    {alert.severity}
                  </span>
                </div>
                <div className="mt-1 text-muted-foreground text-sm">
                  {alert.message}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="rounded-xl border border-border bg-card p-4 sm:p-6">
        <h3 className="mb-4 flex items-center gap-2 font-semibold text-lg">
          <Server className="h-5 w-5 text-sky-500" />
          Runtime Snapshot
        </h3>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-lg bg-muted/40 px-4 py-3">
            <div className="text-muted-foreground text-xs">Snapshot time</div>
            <div className="mt-1 text-sm">
              {new Date(data.timestamp).toLocaleString()}
            </div>
          </div>
          <div className="rounded-lg bg-muted/40 px-4 py-3">
            <div className="text-muted-foreground text-xs">Game uptime</div>
            <div className="mt-1 text-sm">
              {formatUptime(data.gameEngine.uptimeMs)}
            </div>
          </div>
          <div className="rounded-lg bg-muted/40 px-4 py-3">
            <div className="text-muted-foreground text-xs">Tick interval</div>
            <div className="mt-1 text-sm">
              {Math.round(data.gameEngine.tickIntervalMs / 1000)}s
            </div>
          </div>
          <div className="rounded-lg bg-muted/40 px-4 py-3">
            <div className="text-muted-foreground text-xs">Realtime lag</div>
            <div className="mt-1 text-sm">
              {data.realtime.outboxLagSeconds}s oldest event
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

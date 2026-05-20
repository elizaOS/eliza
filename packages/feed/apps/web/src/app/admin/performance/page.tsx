/**
 * Admin Performance Dashboard
 *
 * Displays network statistics, database performance, and allows running load tests
 */

'use client';

import { useCallback, useEffect, useState } from 'react';
import { AdminStandalonePage } from '@/components/admin/AdminStandalonePage';

// Simple replacement components
const Card = ({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) => <div className={`rounded-lg border p-4 ${className}`}>{children}</div>;
const CardHeader = ({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) => <div className={`mb-4 ${className}`}>{children}</div>;
const CardTitle = ({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) => <h3 className={`font-semibold text-lg ${className}`}>{children}</h3>;
const CardDescription = ({ children }: { children: React.ReactNode }) => (
  <p className="text-muted-foreground text-sm">{children}</p>
);
const CardContent = ({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) => <div className={className}>{children}</div>;
const Badge = ({
  children,
  variant = 'default',
}: {
  children: React.ReactNode;
  variant?: string;
}) => (
  <span
    className={`inline-flex items-center rounded-full px-2.5 py-0.5 font-medium text-xs ${
      variant === 'destructive'
        ? 'bg-red-100 text-red-800'
        : 'bg-blue-100 text-blue-800'
    }`}
  >
    {children}
  </span>
);
const Button = ({
  children,
  onClick,
  disabled,
  className = '',
}: {
  children: React.ReactNode;
  onClick?: () => void | Promise<void>;
  disabled?: boolean;
  className?: string;
  variant?: string;
  size?: string;
}) => (
  <button
    onClick={onClick}
    disabled={disabled}
    className={`rounded-md bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50 ${className}`}
  >
    {children}
  </button>
);

interface NetworkStats {
  timestamp: string;
  database: {
    queries: {
      total: number;
      slow: number;
      slowRate: number;
      avgDuration: number;
      p95Duration: number;
      p99Duration: number;
    };
    topSlowQueries: Array<{
      query: string;
      count: number;
      avgDuration: number;
      maxDuration: number;
    }>;
    recentQueries: Array<{
      query: string;
      duration: number;
      timestamp: string;
      model?: string;
      operation?: string;
    }>;
  };
  server: {
    uptime: {
      seconds: number;
      formatted: string;
    };
    memory: {
      heapUsed: number;
      heapTotal: number;
      external: number;
      rss: number;
    };
    env: string;
    pid: number;
  };
  health: {
    database: 'healthy' | 'warning' | 'critical';
    memory: 'healthy' | 'warning' | 'critical';
    overall: 'healthy' | 'warning' | 'critical';
  };
}

interface LoadTestStatus {
  status: 'idle' | 'running';
  scenario?: string;
  startTime?: string;
  runningTimeMs?: number;
  runningTimeSeconds?: number;
  lastResult?: {
    endTime: string;
    totalRequests: number;
    successRate: number;
    avgResponseTime: number;
  };
}

const SCENARIOS = [
  {
    value: 'LIGHT',
    label: 'Light (100 users, 1 min)',
    description: 'Basic load testing',
  },
  {
    value: 'NORMAL',
    label: 'Normal (500 users, 2 min)',
    description: 'Typical production load',
  },
  {
    value: 'HEAVY',
    label: 'Heavy (1000 users, 5 min)',
    description: 'High load scenario',
  },
  {
    value: 'STRESS',
    label: 'Stress (2000+ users, 5 min)',
    description: 'Extreme load test',
  },
];

export default function AdminPerformancePage() {
  const [stats, setStats] = useState<NetworkStats | null>(null);
  const [loadTestStatus, setLoadTestStatus] = useState<LoadTestStatus | null>(
    null
  );
  const [selectedScenario, setSelectedScenario] = useState<string>('NORMAL');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);

  // Fetch network stats
  const fetchStats = useCallback(async () => {
    const response = await fetch('/api/admin/network-stats');

    if (!response.ok) {
      throw new Error('Failed to fetch stats');
    }

    const data = await response.json();
    setStats(data);
    setError(null);
  }, []);

  // Fetch load test status
  const fetchLoadTestStatus = useCallback(async () => {
    const response = await fetch('/api/admin/load-test/status');

    if (!response.ok) {
      throw new Error('Failed to fetch load test status');
    }

    const data = await response.json();
    setLoadTestStatus(data);
  }, []);

  // Start load test
  const startLoadTest = async () => {
    setIsLoading(true);
    setError(null);

    const response = await fetch('/api/admin/load-test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario: selectedScenario }),
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || 'Failed to start load test');
    }

    await fetchLoadTestStatus();
    setIsLoading(false);
  };

  // Auto-refresh stats
  useEffect(() => {
    fetchStats();
    fetchLoadTestStatus();

    if (autoRefresh) {
      const interval = setInterval(() => {
        fetchStats();
        fetchLoadTestStatus();
      }, 5000); // Refresh every 5 seconds

      return () => clearInterval(interval);
    }

    return undefined;
  }, [autoRefresh, fetchLoadTestStatus, fetchStats]);

  const getHealthBadgeVariant = (
    health: 'healthy' | 'warning' | 'critical'
  ): 'default' | 'secondary' | 'destructive' => {
    switch (health) {
      case 'healthy':
        return 'default';
      case 'warning':
        return 'secondary';
      case 'critical':
        return 'destructive';
    }
  };

  return (
    <AdminStandalonePage className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="font-bold text-3xl">Performance Dashboard</h1>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="rounded"
            />
            Auto-refresh (5s)
          </label>
          <Button onClick={fetchStats} variant="outline" size="sm">
            Refresh Now
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded border border-destructive bg-destructive/10 px-4 py-3 text-destructive">
          {error}
        </div>
      )}

      {/* System Health Overview */}
      {stats && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="font-medium text-sm">
                Overall Health
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2">
                <Badge variant={getHealthBadgeVariant(stats.health.overall)}>
                  {stats.health.overall.toUpperCase()}
                </Badge>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="font-medium text-sm">Database</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2">
                <Badge variant={getHealthBadgeVariant(stats.health.database)}>
                  {stats.health.database.toUpperCase()}
                </Badge>
                <span className="text-muted-foreground text-sm">
                  {stats.database.queries.slowRate.toFixed(1)}% slow
                </span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="font-medium text-sm">Memory</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2">
                <Badge variant={getHealthBadgeVariant(stats.health.memory)}>
                  {stats.health.memory.toUpperCase()}
                </Badge>
                <span className="text-muted-foreground text-sm">
                  {stats.server.memory.heapUsed.toFixed(0)}MB /{' '}
                  {stats.server.memory.heapTotal.toFixed(0)}MB
                </span>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Database Performance */}
      {stats && (
        <Card>
          <CardHeader>
            <CardTitle>Database Performance</CardTitle>
            <CardDescription>
              Query metrics from the last 60 seconds
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
              <div>
                <div className="font-bold text-2xl">
                  {stats.database.queries.total.toLocaleString()}
                </div>
                <div className="text-muted-foreground text-xs">
                  Total Queries
                </div>
              </div>
              <div>
                <div className="font-bold text-2xl">
                  {stats.database.queries.slow}
                </div>
                <div className="text-muted-foreground text-xs">
                  Slow Queries
                </div>
              </div>
              <div>
                <div className="font-bold text-2xl">
                  {stats.database.queries.avgDuration.toFixed(1)}ms
                </div>
                <div className="text-muted-foreground text-xs">
                  Avg Duration
                </div>
              </div>
              <div>
                <div className="font-bold text-2xl">
                  {stats.database.queries.p95Duration.toFixed(1)}ms
                </div>
                <div className="text-muted-foreground text-xs">
                  95th Percentile
                </div>
              </div>
              <div>
                <div className="font-bold text-2xl">
                  {stats.database.queries.p99Duration.toFixed(1)}ms
                </div>
                <div className="text-muted-foreground text-xs">
                  99th Percentile
                </div>
              </div>
              <div>
                <div className="font-bold text-2xl">
                  {stats.database.queries.slowRate.toFixed(1)}%
                </div>
                <div className="text-muted-foreground text-xs">Slow Rate</div>
              </div>
            </div>

            {/* Top Slow Queries */}
            {stats.database.topSlowQueries.length > 0 && (
              <div>
                <h3 className="mb-2 font-semibold">Top Slow Queries</h3>
                <div className="space-y-2">
                  {stats.database.topSlowQueries.map((query, idx) => (
                    <div
                      key={idx}
                      className="flex items-center justify-between border-b pb-2 text-sm"
                    >
                      <div className="flex-1">
                        <div className="font-mono">{query.query}</div>
                        <div className="text-muted-foreground text-xs">
                          Count: {query.count}
                        </div>
                      </div>
                      <div className="text-right">
                        <div>Avg: {query.avgDuration.toFixed(1)}ms</div>
                        <div className="text-muted-foreground text-xs">
                          Max: {query.maxDuration.toFixed(1)}ms
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Load Testing */}
      <Card>
        <CardHeader>
          <CardTitle>Load Testing</CardTitle>
          <CardDescription>
            Simulate concurrent users and test system performance
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {loadTestStatus?.status === 'running' ? (
            <div className="rounded border border-blue-200 bg-blue-50 px-4 py-3 text-blue-800">
              <div className="font-semibold">Load test running...</div>
              <div className="text-sm">
                Scenario: {loadTestStatus.scenario} | Running for:{' '}
                {loadTestStatus.runningTimeSeconds}s
              </div>
            </div>
          ) : (
            <>
              <div>
                <label className="mb-2 block font-medium text-sm">
                  Select Scenario
                </label>
                <select
                  value={selectedScenario}
                  onChange={(e) => setSelectedScenario(e.target.value)}
                  className="w-full rounded border px-3 py-2"
                  disabled={isLoading}
                >
                  {SCENARIOS.map((scenario) => (
                    <option key={scenario.value} value={scenario.value}>
                      {scenario.label} - {scenario.description}
                    </option>
                  ))}
                </select>
              </div>

              <Button onClick={startLoadTest} disabled={isLoading}>
                {isLoading ? 'Starting...' : 'Start Load Test'}
              </Button>
            </>
          )}

          {loadTestStatus?.lastResult && (
            <div>
              <h3 className="mb-2 font-semibold">Last Test Results</h3>
              <div className="grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
                <div>
                  <div className="font-bold text-lg">
                    {loadTestStatus.lastResult.totalRequests.toLocaleString()}
                  </div>
                  <div className="text-muted-foreground text-xs">
                    Total Requests
                  </div>
                </div>
                <div>
                  <div className="font-bold text-lg">
                    {(loadTestStatus.lastResult.successRate * 100).toFixed(2)}%
                  </div>
                  <div className="text-muted-foreground text-xs">
                    Success Rate
                  </div>
                </div>
                <div>
                  <div className="font-bold text-lg">
                    {loadTestStatus.lastResult.avgResponseTime.toFixed(1)}ms
                  </div>
                  <div className="text-muted-foreground text-xs">
                    Avg Response Time
                  </div>
                </div>
                <div>
                  <div className="font-bold text-lg">
                    {new Date(
                      loadTestStatus.lastResult.endTime
                    ).toLocaleTimeString()}
                  </div>
                  <div className="text-muted-foreground text-xs">
                    Completed At
                  </div>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Server Info */}
      {stats && (
        <Card>
          <CardHeader>
            <CardTitle>Server Information</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
              <div>
                <div className="font-semibold">Uptime</div>
                <div>{stats.server.uptime.formatted}</div>
              </div>
              <div>
                <div className="font-semibold">Environment</div>
                <div>{stats.server.env}</div>
              </div>
              <div>
                <div className="font-semibold">Process ID</div>
                <div>{stats.server.pid}</div>
              </div>
              <div>
                <div className="font-semibold">Last Updated</div>
                <div>{new Date(stats.timestamp).toLocaleTimeString()}</div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </AdminStandalonePage>
  );
}

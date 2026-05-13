import { useState, useEffect } from 'react'
import {
  Activity,
  AlertTriangle,
  CheckCircle,
  XCircle,
  Server,
  HardDrive,
  Container,
  Clock,
  Zap,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  FileWarning,
  ExternalLink
} from 'lucide-react'

interface HealthData {
  timestamp: string
  status: 'healthy' | 'warning' | 'critical'
  issues: string[]
  metrics: {
    harborProcesses: number
    dockerContainers: {
      total: number
      stuckCount: number
      stuckContainers: string[]
    }
    disk: {
      usedPercent: number
      availableGb: number
    }
    memory: {
      usedPercent: number
      availableGb: number
    }
    trials: {
      completedLastHour: number
      errorsLastHour: number
      throughputPerHour: number
    }
  }
}

interface HealthPanelProps {
  onSelect?: (type: 'system-info' | 'stale-trials' | 'containers' | 'harbor-jobs', containerTab?: 'all' | 'stuck') => void
}

export function HealthPanel({ onSelect }: HealthPanelProps) {
  const [health, setHealth] = useState<HealthData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(true)

  const fetchHealth = async () => {
    try {
      const res = await fetch('/api/health')
      if (!res.ok) throw new Error('Failed to fetch health')
      const data = await res.json()
      setHealth(data)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchHealth()
    // Refresh every 3 seconds for more responsive CPU/memory updates
    const interval = setInterval(fetchHealth, 3000)
    return () => clearInterval(interval)
  }, [])

  const statusColors = {
    healthy: 'bg-green-500',
    warning: 'bg-yellow-500',
    critical: 'bg-red-500',
  }

  const statusIcons = {
    healthy: <CheckCircle className="w-4 h-4 text-green-500" />,
    warning: <AlertTriangle className="w-4 h-4 text-yellow-500" />,
    critical: <XCircle className="w-4 h-4 text-red-500" />,
  }

  if (loading && !health) {
    return (
      <div className="border border-border rounded-lg p-3 bg-card">
        <div className="flex items-center gap-2 text-muted-foreground">
          <RefreshCw className="w-4 h-4 animate-spin" />
          <span className="text-sm">Loading health status...</span>
        </div>
      </div>
    )
  }

  if (error && !health) {
    return (
      <div className="border border-border rounded-lg p-3 bg-card">
        <div className="flex items-center gap-2 text-red-500">
          <XCircle className="w-4 h-4" />
          <span className="text-sm">Health check failed: {error}</span>
        </div>
      </div>
    )
  }

  if (!health) return null

  const { metrics } = health

  return (
    <div className="border border-border rounded-lg bg-card overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-3 py-2 flex items-center gap-2 hover:bg-muted/50 transition-colors"
      >
        {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        <Activity className="w-4 h-4" />
        <span className="font-medium text-sm">System Health</span>
        <div className={`ml-auto w-2 h-2 rounded-full ${statusColors[health.status]}`} />
        {statusIcons[health.status]}
        <span className={`text-xs font-medium ${
          health.status === 'healthy' ? 'text-green-500' :
          health.status === 'warning' ? 'text-yellow-500' : 'text-red-500'
        }`}>
          {health.status.toUpperCase()}
        </span>
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-3 border-t border-border">
          {/* Issues */}
          {health.issues.length > 0 && (
            <div className="mt-3 space-y-1">
              {health.issues.map((issue, i) => (
                <div key={i} className="flex items-start gap-2 text-xs">
                  <AlertTriangle className="w-3 h-3 text-yellow-500 mt-0.5 shrink-0" />
                  <span className="text-muted-foreground">{issue}</span>
                </div>
              ))}
            </div>
          )}

          {/* Metrics Grid - Clickable */}
          <div className="grid grid-cols-2 gap-2 mt-3">
            {/* Harbor Jobs - Clickable */}
            <button
              onClick={() => onSelect?.('harbor-jobs')}
              className="flex items-center gap-2 p-2 bg-muted/30 rounded hover:bg-muted/50 transition-colors text-left"
            >
              <Server className="w-4 h-4 text-muted-foreground" />
              <div className="flex-1 min-w-0">
                <div className="text-xs text-muted-foreground">Harbor Jobs</div>
                <div className={`text-sm font-medium ${metrics.harborProcesses > 0 ? 'text-green-500' : 'text-red-500'}`}>
                  {metrics.harborProcesses} running
                </div>
              </div>
              <ExternalLink className="w-3 h-3 text-muted-foreground" />
            </button>

            {/* Docker Containers - Always goes to containers view */}
            <button
              onClick={() => onSelect?.('containers')}
              className="flex items-center gap-2 p-2 bg-muted/30 rounded hover:bg-muted/50 transition-colors text-left"
            >
              <Container className="w-4 h-4 text-muted-foreground" />
              <div className="flex-1 min-w-0">
                <div className="text-xs text-muted-foreground">Containers</div>
                <div className="text-sm font-medium">
                  {metrics.dockerContainers.total} running
                </div>
              </div>
              <ExternalLink className="w-3 h-3 text-muted-foreground" />
            </button>

            {/* Disk - Clickable */}
            <button
              onClick={() => onSelect?.('system-info')}
              className="flex items-center gap-2 p-2 bg-muted/30 rounded hover:bg-muted/50 transition-colors text-left"
            >
              <HardDrive className="w-4 h-4 text-muted-foreground" />
              <div className="flex-1 min-w-0">
                <div className="text-xs text-muted-foreground">Disk</div>
                <div className={`text-sm font-medium ${
                  metrics.disk.usedPercent > 90 ? 'text-red-500' :
                  metrics.disk.usedPercent > 80 ? 'text-yellow-500' : ''
                }`}>
                  {metrics.disk.usedPercent}% used
                </div>
              </div>
              <div className="w-12 h-1.5 bg-muted rounded-full overflow-hidden">
                <div
                  className={`h-full ${
                    metrics.disk.usedPercent > 90 ? 'bg-red-500' :
                    metrics.disk.usedPercent > 80 ? 'bg-yellow-500' : 'bg-green-500'
                  }`}
                  style={{ width: `${metrics.disk.usedPercent}%` }}
                />
              </div>
            </button>

            {/* Memory - Clickable */}
            <button
              onClick={() => onSelect?.('system-info')}
              className="flex items-center gap-2 p-2 bg-muted/30 rounded hover:bg-muted/50 transition-colors text-left"
            >
              <Zap className="w-4 h-4 text-muted-foreground" />
              <div className="flex-1 min-w-0">
                <div className="text-xs text-muted-foreground">Memory</div>
                <div className={`text-sm font-medium ${
                  metrics.memory.usedPercent > 90 ? 'text-red-500' :
                  metrics.memory.usedPercent > 80 ? 'text-yellow-500' : ''
                }`}>
                  {metrics.memory.usedPercent}% used
                </div>
              </div>
              <div className="w-12 h-1.5 bg-muted rounded-full overflow-hidden">
                <div
                  className={`h-full ${
                    metrics.memory.usedPercent > 90 ? 'bg-red-500' :
                    metrics.memory.usedPercent > 80 ? 'bg-yellow-500' : 'bg-green-500'
                  }`}
                  style={{ width: `${metrics.memory.usedPercent}%` }}
                />
              </div>
            </button>

            {/* Throughput */}
            <div className="flex items-center gap-2 p-2 bg-muted/30 rounded">
              <Clock className="w-4 h-4 text-muted-foreground" />
              <div className="flex-1 min-w-0">
                <div className="text-xs text-muted-foreground">Last Hour</div>
                <div className="text-sm font-medium">
                  {metrics.trials.completedLastHour} completed
                </div>
              </div>
            </div>

            {/* Stale Trials - Clickable */}
            <button
              onClick={() => onSelect?.('stale-trials')}
              className="flex items-center gap-2 p-2 bg-muted/30 rounded hover:bg-muted/50 transition-colors text-left"
            >
              <FileWarning className="w-4 h-4 text-muted-foreground" />
              <div className="flex-1 min-w-0">
                <div className="text-xs text-muted-foreground">Stale Trials</div>
                <div className="text-sm font-medium text-yellow-500">
                  Click to view
                </div>
              </div>
              <ExternalLink className="w-3 h-3 text-muted-foreground" />
            </button>
          </div>

          {/* Stuck containers indicator - click to view in containers tab */}
          {metrics.dockerContainers.stuckCount > 0 && (
            <div className="pt-2 border-t border-border">
              <button
                onClick={() => onSelect?.('containers', 'stuck')}
                className="w-full p-2 bg-yellow-500/10 border border-yellow-500/30 rounded hover:bg-yellow-500/20 transition-colors text-left"
              >
                <div className="flex items-center gap-2">
                  <Container className="w-4 h-4 text-yellow-500" />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-muted-foreground">Stuck Containers</div>
                    <div className="text-sm font-medium text-yellow-500">
                      {metrics.dockerContainers.stuckCount} running &gt;1h
                    </div>
                  </div>
                  <ExternalLink className="w-3 h-3 text-yellow-500" />
                </div>
                <div className="text-xs text-muted-foreground mt-1 truncate">
                  {metrics.dockerContainers.stuckContainers.slice(0, 2).join(', ')}
                  {metrics.dockerContainers.stuckContainers.length > 2 && '...'}
                </div>
              </button>
            </div>
          )}

          {/* Last updated */}
          <div className="text-xs text-muted-foreground text-right pt-1">
            Updated: {new Date(health.timestamp).toLocaleTimeString()}
          </div>
        </div>
      )}
    </div>
  )
}

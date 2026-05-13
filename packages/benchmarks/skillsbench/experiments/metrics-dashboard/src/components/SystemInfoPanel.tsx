import { useState, useEffect } from 'react'
import {
  Server,
  HardDrive,
  Container,
  Zap,
  RefreshCw,
  X,
  Cpu,
  Trash2,
  FileWarning,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  Clock,
  AlertTriangle,
  Terminal,
  FolderOpen,
  ExternalLink
} from 'lucide-react'

interface SystemInfo {
  cpuUsage: number
  memory: { totalMb: number; usedMb: number; freeMb: number; availableMb: number }
  disk: { total: string; used: string; available: string; usedPercent: number }
  containers: Array<{ name: string; status: string; runningFor: string; image: string }>
  harborProcesses: Array<{ pid: string; cpu: string; mem: string; command: string }>
  gpus?: Array<{ name: string; memUsedMb: number; memTotalMb: number; utilizationPercent: number }>
}

interface StuckContainer {
  name: string
  runningFor: string
  runningForMs: number
  status: string
  image: string
  taskName: string | null
  trialId: string | null
  jobName: string | null
  trialPath: string | null
  logs: string
}

interface StaleTrial {
  jobName: string
  trialName: string
  path: string
  startedAt: string | null
  lastModified: string
  hasResultJson: boolean
  resultJsonEmpty: boolean
  ageDurationMs: number
}

function formatDuration(ms: number): string {
  const hours = Math.floor(ms / 3600000)
  const mins = Math.floor((ms % 3600000) / 60000)
  if (hours > 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`
  if (hours > 0) return `${hours}h ${mins}m`
  return `${mins}m`
}

interface SystemInfoPanelProps {
  type: 'system-info' | 'containers' | 'stale-trials'
  onClose: () => void
  onRefresh?: () => void
  onFilesSelect?: (trialPath: string) => void
  initialContainerTab?: 'all' | 'stuck'
}

export function SystemInfoPanel({ type, onClose, onRefresh, onFilesSelect, initialContainerTab = 'all' }: SystemInfoPanelProps) {
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null)
  const [staleTrials, setStaleTrials] = useState<{ count: number; trials: StaleTrial[] } | null>(null)
  const [stuckContainers, setStuckContainers] = useState<StuckContainer[]>([])
  const [loading, setLoading] = useState(true)
  const [killing, setKilling] = useState<string | null>(null)
  const [killingAll, setKillingAll] = useState(false)
  const [containerTab, setContainerTab] = useState<'all' | 'stuck'>(initialContainerTab)
  const [expandedContainers, setExpandedContainers] = useState<Set<string>>(new Set())

  const fetchData = async () => {
    setLoading(true)
    try {
      if (type === 'stale-trials') {
        const res = await fetch('/api/stale-trials')
        const data = await res.json()
        setStaleTrials(data)
      } else if (type === 'containers') {
        // Fetch both system info (for all containers) and stuck containers
        const [sysRes, stuckRes] = await Promise.all([
          fetch('/api/system-info'),
          fetch('/api/stuck-containers')
        ])
        const sysData = await sysRes.json()
        const stuckData = await stuckRes.json()
        setSystemInfo(sysData)
        setStuckContainers(stuckData.containers || [])
      } else {
        const res = await fetch('/api/system-info')
        const data = await res.json()
        setSystemInfo(data)
      }
    } catch (err) {
      console.error('Failed to fetch data:', err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchData()
    // Auto-refresh every 5 seconds for containers, 10 for others
    const interval = setInterval(fetchData, type === 'containers' ? 5000 : 10000)
    return () => clearInterval(interval)
  }, [type])

  // Reset tab when initialContainerTab changes
  useEffect(() => {
    if (initialContainerTab) {
      setContainerTab(initialContainerTab)
    }
  }, [initialContainerTab])

  const toggleExpandContainer = (name: string) => {
    setExpandedContainers(prev => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  const markTrialDone = async (jobName: string, trialName: string) => {
    if (!confirm(`Mark ${trialName} as done?`)) return
    try {
      const res = await fetch('/api/mark-done', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobName, trialName })
      })
      const data = await res.json()
      if (data.success) {
        fetchData()
        onRefresh?.()
      } else {
        alert(`Error: ${data.error}`)
      }
    } catch (err) {
      alert(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`)
    }
  }

  const markAllDone = async () => {
    if (!staleTrials || staleTrials.count === 0) return
    if (!confirm(`Mark all ${staleTrials.count} stale trials as done?`)) return

    for (const trial of staleTrials.trials) {
      try {
        await fetch('/api/mark-done', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobName: trial.jobName, trialName: trial.trialName })
        })
      } catch {}
    }
    fetchData()
    onRefresh?.()
  }

  const killStuckContainers = async () => {
    if (!confirm('Kill all stuck containers (running >1 hour)?')) return
    setKillingAll(true)
    try {
      const res = await fetch('/api/kill-stuck', { method: 'POST' })
      const data = await res.json()
      if (data.success) {
        alert(`Killed ${data.killedCount} containers`)
        fetchData()
      } else {
        alert(`Error: ${data.error}`)
      }
    } catch (err) {
      alert(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`)
    } finally {
      setKillingAll(false)
    }
  }

  const killSingleContainer = async (name: string) => {
    if (!confirm(`Stop container "${name}"?`)) return
    setKilling(name)
    try {
      const res = await fetch('/api/kill-container', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ containerName: name })
      })
      const data = await res.json()
      if (data.success) {
        setStuckContainers(prev => prev.filter(c => c.name !== name))
        fetchData()
      } else {
        alert(`Error: ${data.error}`)
      }
    } catch (err) {
      alert(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`)
    } finally {
      setKilling(null)
    }
  }

  const titles = {
    'system-info': 'System Information',
    'containers': 'Docker Containers',
    'stale-trials': 'Stale Trials'
  }

  return (
    <div className="border border-border rounded-lg bg-card overflow-hidden flex flex-col h-[calc(100vh-8rem)]">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border flex items-center justify-between bg-muted/30 shrink-0">
        <div className="flex items-center gap-2">
          {type === 'system-info' && <Server className="w-4 h-4" />}
          {type === 'containers' && <Container className="w-4 h-4" />}
          {type === 'stale-trials' && <FileWarning className="w-4 h-4" />}
          <span className="font-medium text-sm">{titles[type]}</span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={fetchData} className="p-1 hover:bg-muted rounded" title="Refresh">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button onClick={onClose} className="p-1 hover:bg-muted rounded">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-4">
        {loading && !systemInfo && !staleTrials ? (
          <div className="flex items-center justify-center py-8">
            <RefreshCw className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : type === 'system-info' && systemInfo ? (
          <div className="space-y-4">
            {/* CPU */}
            <div className="p-3 bg-muted/30 rounded-lg">
              <div className="flex items-center gap-2 mb-2">
                <Cpu className="w-4 h-4" />
                <span className="font-medium">CPU</span>
              </div>
              <div className="text-2xl font-bold">{systemInfo.cpuUsage?.toFixed(1) || 0}%</div>
            </div>

            {/* Memory */}
            <div className="p-3 bg-muted/30 rounded-lg">
              <div className="flex items-center gap-2 mb-2">
                <Zap className="w-4 h-4" />
                <span className="font-medium">Memory</span>
              </div>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div>Total: {Math.round((systemInfo.memory?.totalMb || 0) / 1024)} GB</div>
                <div>Used: {Math.round((systemInfo.memory?.usedMb || 0) / 1024)} GB</div>
                <div>Free: {Math.round((systemInfo.memory?.freeMb || 0) / 1024)} GB</div>
                <div>Available: {Math.round((systemInfo.memory?.availableMb || 0) / 1024)} GB</div>
              </div>
              <div className="mt-2 h-2 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-blue-500"
                  style={{ width: `${systemInfo.memory?.totalMb ? (systemInfo.memory.usedMb / systemInfo.memory.totalMb) * 100 : 0}%` }}
                />
              </div>
            </div>

            {/* Disk */}
            <div className="p-3 bg-muted/30 rounded-lg">
              <div className="flex items-center gap-2 mb-2">
                <HardDrive className="w-4 h-4" />
                <span className="font-medium">Disk</span>
              </div>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div>Total: {systemInfo.disk?.total}</div>
                <div>Used: {systemInfo.disk?.used}</div>
                <div>Available: {systemInfo.disk?.available}</div>
                <div>Usage: {systemInfo.disk?.usedPercent}%</div>
              </div>
              <div className="mt-2 h-2 bg-muted rounded-full overflow-hidden">
                <div
                  className={`h-full ${systemInfo.disk?.usedPercent > 80 ? 'bg-yellow-500' : 'bg-green-500'}`}
                  style={{ width: `${systemInfo.disk?.usedPercent || 0}%` }}
                />
              </div>
            </div>

            {/* Harbor Processes */}
            <div className="p-3 bg-muted/30 rounded-lg">
              <div className="flex items-center gap-2 mb-2">
                <Server className="w-4 h-4" />
                <span className="font-medium">Harbor Processes ({systemInfo.harborProcesses?.length || 0})</span>
              </div>
              {systemInfo.harborProcesses?.length > 0 ? (
                <div className="space-y-1 text-xs font-mono max-h-40 overflow-auto">
                  {systemInfo.harborProcesses.map((p, i) => (
                    <div key={i} className="flex gap-2 p-1 bg-muted/50 rounded">
                      <span className="text-muted-foreground">PID {p.pid}</span>
                      <span>CPU: {p.cpu}%</span>
                      <span>MEM: {p.mem}%</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-sm text-red-500">No harbor processes running</div>
              )}
            </div>

            {/* GPUs */}
            {systemInfo.gpus && systemInfo.gpus.length > 0 && (
              <div className="p-3 bg-muted/30 rounded-lg">
                <div className="flex items-center gap-2 mb-2">
                  <Cpu className="w-4 h-4" />
                  <span className="font-medium">GPUs</span>
                </div>
                <div className="space-y-2">
                  {systemInfo.gpus.map((gpu, i) => (
                    <div key={i} className="text-sm">
                      <div className="font-medium">{gpu.name}</div>
                      <div className="text-muted-foreground">
                        Memory: {gpu.memUsedMb}/{gpu.memTotalMb} MB | Utilization: {gpu.utilizationPercent}%
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : type === 'containers' && systemInfo ? (
          <div className="space-y-3">
            {/* Tabs */}
            <div className="flex border-b border-border">
              <button
                onClick={() => setContainerTab('all')}
                className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                  containerTab === 'all'
                    ? 'border-primary text-primary'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                All ({systemInfo.containers?.length || 0})
              </button>
              <button
                onClick={() => setContainerTab('stuck')}
                className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors flex items-center gap-2 ${
                  containerTab === 'stuck'
                    ? 'border-yellow-500 text-yellow-500'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                <AlertTriangle className="w-3 h-3" />
                Stuck ({stuckContainers.length})
              </button>
            </div>

            {/* All Containers Tab */}
            {containerTab === 'all' && (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">{systemInfo.containers?.length || 0} containers running</span>
                  {stuckContainers.length > 0 && (
                    <button
                      onClick={killStuckContainers}
                      disabled={killingAll}
                      className="flex items-center gap-1 px-2 py-1 text-xs bg-red-500/20 text-red-500 rounded hover:bg-red-500/30 transition-colors disabled:opacity-50"
                    >
                      {killingAll ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                      Kill Stuck
                    </button>
                  )}
                </div>
                {systemInfo.containers?.length === 0 ? (
                  <div className="text-muted-foreground py-4 text-center">No containers running</div>
                ) : (
                  <div className="space-y-2">
                    {systemInfo.containers?.map((c, i) => {
                      const isStuck = c.runningFor?.includes('hour')
                      return (
                        <div key={i} className={`p-3 rounded-lg ${isStuck ? 'bg-yellow-500/10 border border-yellow-500/30' : 'bg-muted/30'}`}>
                          <div className="font-medium text-sm truncate">{c.name}</div>
                          <div className="text-xs text-muted-foreground mt-1">
                            <div className="truncate">{c.image}</div>
                            <div className="flex gap-2 mt-1">
                              <span className={isStuck ? 'text-yellow-500' : ''}>{c.runningFor}</span>
                              <span>|</span>
                              <span>{c.status}</span>
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </>
            )}

            {/* Stuck Containers Tab */}
            {containerTab === 'stuck' && (
              <>
                {stuckContainers.length > 0 && (
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">{stuckContainers.length} containers running &gt;1h</span>
                    <button
                      onClick={killStuckContainers}
                      disabled={killingAll}
                      className="flex items-center gap-1 px-2 py-1 text-xs bg-red-500/20 text-red-500 rounded hover:bg-red-500/30 transition-colors disabled:opacity-50"
                    >
                      {killingAll ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                      Stop All
                    </button>
                  </div>
                )}
                {stuckContainers.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    <Container className="w-8 h-8 mx-auto mb-2 opacity-50" />
                    No stuck containers
                  </div>
                ) : (
                  <div className="space-y-2">
                    {stuckContainers.map((container) => {
                      const isExpanded = expandedContainers.has(container.name)
                      const isKilling = killing === container.name
                      return (
                        <div key={container.name} className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg overflow-hidden">
                          {/* Container header */}
                          <div className="px-3 py-2 flex items-center gap-2">
                            <button
                              onClick={() => toggleExpandContainer(container.name)}
                              className="p-1 hover:bg-muted rounded"
                            >
                              {isExpanded ? (
                                <ChevronDown className="w-4 h-4" />
                              ) : (
                                <ChevronRight className="w-4 h-4" />
                              )}
                            </button>

                            <AlertTriangle className="w-4 h-4 text-yellow-500 shrink-0" />

                            <div className="flex-1 min-w-0">
                              <div className="font-medium text-sm truncate" title={container.name}>
                                {container.taskName || container.name}
                              </div>
                              <div className="text-xs text-muted-foreground flex items-center gap-3">
                                <span className="flex items-center gap-1">
                                  <Clock className="w-3 h-3" />
                                  {container.runningFor}
                                </span>
                                {container.jobName && (
                                  <span>Job: {container.jobName}</span>
                                )}
                                {container.trialId && (
                                  <span>Trial: {container.trialId}</span>
                                )}
                              </div>
                            </div>

                            <div className="flex items-center gap-2 shrink-0">
                              {container.trialPath && onFilesSelect && (
                                <button
                                  onClick={() => onFilesSelect(container.trialPath!)}
                                  className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-primary"
                                  title="View trial files"
                                >
                                  <FolderOpen className="w-4 h-4" />
                                </button>
                              )}
                              <button
                                onClick={() => killSingleContainer(container.name)}
                                disabled={isKilling}
                                className="p-1.5 rounded bg-red-500/20 text-red-500 hover:bg-red-500/30 disabled:opacity-50"
                                title="Stop container"
                              >
                                {isKilling ? (
                                  <RefreshCw className="w-4 h-4 animate-spin" />
                                ) : (
                                  <Trash2 className="w-4 h-4" />
                                )}
                              </button>
                            </div>
                          </div>

                          {/* Expanded details */}
                          {isExpanded && (
                            <div className="px-3 py-3 bg-muted/20 border-t border-yellow-500/20 space-y-3">
                              {/* Container info */}
                              <div className="grid grid-cols-2 gap-2 text-sm">
                                <div>
                                  <span className="text-muted-foreground">Container:</span>
                                  <code className="ml-2 text-xs bg-muted px-1.5 py-0.5 rounded break-all">
                                    {container.name}
                                  </code>
                                </div>
                                <div>
                                  <span className="text-muted-foreground">Status:</span>
                                  <span className="ml-2">{container.status}</span>
                                </div>
                                <div className="col-span-2">
                                  <span className="text-muted-foreground">Image:</span>
                                  <code className="ml-2 text-xs bg-muted px-1.5 py-0.5 rounded">
                                    {container.image}
                                  </code>
                                </div>
                                {container.trialPath && (
                                  <div className="col-span-2 flex items-center gap-2">
                                    <span className="text-muted-foreground">Trial Path:</span>
                                    <code className="text-xs bg-muted px-1.5 py-0.5 rounded">
                                      {container.trialPath}
                                    </code>
                                    {onFilesSelect && (
                                      <button
                                        onClick={() => onFilesSelect(container.trialPath!)}
                                        className="text-primary hover:underline text-xs flex items-center gap-1"
                                      >
                                        <ExternalLink className="w-3 h-3" />
                                        View Files
                                      </button>
                                    )}
                                  </div>
                                )}
                              </div>

                              {/* Logs */}
                              <div>
                                <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground mb-1">
                                  <Terminal className="w-3 h-3" />
                                  Last 50 lines of logs
                                </div>
                                <pre className="text-xs bg-black/80 text-green-400 p-3 rounded overflow-auto max-h-64 whitespace-pre-wrap break-words font-mono">
                                  {container.logs || '(No logs available)'}
                                </pre>
                              </div>
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </>
            )}
          </div>
        ) : type === 'stale-trials' && staleTrials ? (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">{staleTrials.count} stale trials</span>
              {staleTrials.count > 0 && (
                <button
                  onClick={markAllDone}
                  className="flex items-center gap-1 px-2 py-1 text-xs bg-red-500/20 text-red-500 rounded hover:bg-red-500/30 transition-colors"
                >
                  <CheckCircle className="w-3 h-3" />
                  Mark All Done
                </button>
              )}
            </div>
            {staleTrials.count === 0 ? (
              <div className="text-green-500 py-4 text-center flex items-center justify-center gap-2">
                <CheckCircle className="w-5 h-5" />
                All trials have completed results!
              </div>
            ) : (
              <div className="space-y-2">
                {staleTrials.trials.map((trial, i) => (
                  <div key={i} className="p-3 bg-muted/30 rounded-lg">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-sm truncate">{trial.trialName}</div>
                        <div className="text-xs text-muted-foreground mt-1">
                          <div>Job: {trial.jobName}</div>
                          <div className="flex gap-2 mt-1">
                            <span className={trial.ageDurationMs > 3600000 ? 'text-yellow-500' : ''}>
                              Age: {formatDuration(trial.ageDurationMs)}
                            </span>
                            <span>|</span>
                            <span>
                              {trial.hasResultJson
                                ? (trial.resultJsonEmpty ? 'Empty result.json' : 'Incomplete')
                                : 'No result.json'}
                            </span>
                          </div>
                          <div className="text-xs mt-1">
                            Last modified: {new Date(trial.lastModified).toLocaleString()}
                          </div>
                        </div>
                      </div>
                      <button
                        onClick={() => markTrialDone(trial.jobName, trial.trialName)}
                        className="px-2 py-1 text-xs bg-red-500/20 text-red-500 rounded hover:bg-red-500/30 transition-colors shrink-0"
                      >
                        Mark Done
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="text-muted-foreground py-4 text-center">Failed to load data</div>
        )}
      </div>
    </div>
  )
}

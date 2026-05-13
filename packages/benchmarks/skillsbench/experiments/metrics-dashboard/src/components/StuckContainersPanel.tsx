import { useState, useEffect } from 'react'
import {
  Container,
  Clock,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  X,
  Trash2,
  FolderOpen,
  Terminal,
  AlertTriangle,
  ExternalLink
} from 'lucide-react'

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

interface StuckContainersPanelProps {
  onClose: () => void
  onFilesSelect?: (trialPath: string) => void
}

export function StuckContainersPanel({ onClose, onFilesSelect }: StuckContainersPanelProps) {
  const [containers, setContainers] = useState<StuckContainer[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedContainers, setExpandedContainers] = useState<Set<string>>(new Set())
  const [killing, setKilling] = useState<string | null>(null)

  const fetchContainers = async () => {
    try {
      const res = await fetch('/api/stuck-containers')
      const data = await res.json()
      setContainers(data.containers || [])
    } catch (err) {
      console.error('Failed to fetch stuck containers:', err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchContainers()
    const interval = setInterval(fetchContainers, 5000)
    return () => clearInterval(interval)
  }, [])

  const toggleExpand = (name: string) => {
    setExpandedContainers(prev => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  const killContainer = async (name: string) => {
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
        // Remove from list
        setContainers(prev => prev.filter(c => c.name !== name))
      } else {
        alert(`Error: ${data.error}`)
      }
    } catch (err) {
      alert(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`)
    } finally {
      setKilling(null)
    }
  }

  const killAllContainers = async () => {
    if (!confirm(`Stop all ${containers.length} stuck containers?`)) return
    try {
      const res = await fetch('/api/kill-stuck', { method: 'POST' })
      const data = await res.json()
      if (data.success) {
        alert(`Stopped ${data.killedCount} containers`)
        fetchContainers()
      } else {
        alert(`Error: ${data.error}`)
      }
    } catch (err) {
      alert(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`)
    }
  }

  return (
    <div className="border border-border rounded-lg bg-card overflow-hidden flex flex-col h-[calc(100vh-8rem)]">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border flex items-center justify-between bg-muted/30 shrink-0">
        <div className="flex items-center gap-2">
          <Container className="w-5 h-5 text-yellow-500" />
          <span className="font-medium">Stuck Containers</span>
          <span className="text-xs text-muted-foreground">({containers.length} running &gt;1h)</span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={fetchContainers} className="p-1.5 hover:bg-muted rounded" title="Refresh">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button onClick={onClose} className="p-1.5 hover:bg-muted rounded">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Kill All button */}
      {containers.length > 0 && (
        <div className="px-4 py-2 border-b border-border bg-red-500/10">
          <button
            onClick={killAllContainers}
            className="flex items-center gap-2 px-3 py-1.5 text-sm bg-red-500/20 text-red-500 rounded hover:bg-red-500/30 transition-colors"
          >
            <Trash2 className="w-4 h-4" />
            Stop All {containers.length} Containers
          </button>
        </div>
      )}

      {/* Containers list */}
      <div className="flex-1 overflow-auto">
        {loading && containers.length === 0 ? (
          <div className="flex items-center justify-center py-8">
            <RefreshCw className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : containers.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <Container className="w-8 h-8 mx-auto mb-2 opacity-50" />
            No stuck containers
          </div>
        ) : (
          <div className="divide-y divide-border">
            {containers.map((container) => {
              const isExpanded = expandedContainers.has(container.name)
              const isKilling = killing === container.name
              return (
                <div key={container.name} className="bg-card">
                  {/* Container header */}
                  <div className="px-4 py-3 flex items-center gap-3">
                    <button
                      onClick={() => toggleExpand(container.name)}
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
                        onClick={() => killContainer(container.name)}
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
                    <div className="px-4 py-3 bg-muted/20 border-t border-border space-y-3">
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
      </div>
    </div>
  )
}

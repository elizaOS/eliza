import { useState, useEffect } from 'react'
import {
  Clock,
  CheckCircle,
  XCircle,
  AlertTriangle,
  RefreshCw,
  X,
  Play,
  Timer,
  FolderOpen
} from 'lucide-react'

interface CompletedTrial {
  trialName: string
  taskName: string
  agent: string
  model: string
  status: string
  reward: number | null
  finishedAt: string
  durationMs: number
}

interface InProgressTrial {
  trialName: string
  taskName: string
  agent: string
  model: string
  startedAt: string | null
  lastModified: string
  ageDurationMs: number
}

interface JobActivity {
  jobName: string
  completedCount: number
  inProgressCount: number
  recentCompleted: CompletedTrial[]
  inProgress: InProgressTrial[]
}

function formatDuration(ms: number): string {
  if (ms < 0) return '-'
  const hours = Math.floor(ms / 3600000)
  const mins = Math.floor((ms % 3600000) / 60000)
  const secs = Math.floor((ms % 60000) / 1000)
  if (hours > 0) return `${hours}h ${mins}m`
  if (mins > 0) return `${mins}m ${secs}s`
  return `${secs}s`
}

function formatTime(isoString: string): string {
  // Add 'Z' if no timezone info to treat as UTC
  const dateStr = isoString.includes('Z') || isoString.includes('+') ? isoString : isoString + 'Z'
  const date = new Date(dateStr)
  const now = new Date()
  const isToday = date.toDateString() === now.toDateString()

  if (isToday) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  // Show date if not today
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' +
         date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

interface JobActivityPanelProps {
  jobName: string
  agent?: string
  model?: string
  onClose: () => void
  onTrialSelect?: (trialPath: string) => void
  onFilesSelect?: (trialPath: string) => void
}

export function JobActivityPanel({ jobName, agent, model, onClose, onTrialSelect, onFilesSelect }: JobActivityPanelProps) {
  const [activity, setActivity] = useState<JobActivity | null>(null)
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<'in-progress' | 'completed'>('in-progress')

  const fetchActivity = async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ job: jobName })
      if (agent) params.append('agent', agent)
      if (model) params.append('model', model)

      const res = await fetch(`/api/job-activity?${params}`)
      const data = await res.json()
      setActivity(data)
    } catch (err) {
      console.error('Failed to fetch activity:', err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchActivity()
    const interval = setInterval(fetchActivity, 5000) // Refresh every 5s
    return () => clearInterval(interval)
  }, [jobName, agent, model])

  const statusColors: Record<string, string> = {
    pass: 'text-green-500',
    fail: 'text-red-500',
    error: 'text-orange-500',
    running: 'text-blue-500',
  }

  const statusIcons: Record<string, React.ReactNode> = {
    pass: <CheckCircle className="w-3 h-3 text-green-500" />,
    fail: <XCircle className="w-3 h-3 text-red-500" />,
    error: <AlertTriangle className="w-3 h-3 text-orange-500" />,
    running: <Play className="w-3 h-3 text-blue-500" />,
  }

  const title = agent && model
    ? `${agent} / ${model.split('/').pop()}`
    : jobName

  return (
    <div className="border border-border rounded-lg bg-card overflow-hidden flex flex-col h-[calc(100vh-8rem)]">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border flex items-center justify-between bg-muted/30 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <Clock className="w-4 h-4 shrink-0" />
          <span className="font-medium text-sm truncate">{title}</span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={fetchActivity} className="p-1 hover:bg-muted rounded" title="Refresh">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button onClick={onClose} className="p-1 hover:bg-muted rounded">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Summary */}
      {activity && (
        <div className="px-4 py-2 border-b border-border flex items-center gap-4 text-sm bg-muted/20">
          <span className="flex items-center gap-1">
            <Play className="w-3 h-3 text-blue-500" />
            {activity.inProgressCount} in progress
          </span>
          <span className="flex items-center gap-1">
            <CheckCircle className="w-3 h-3 text-green-500" />
            {activity.completedCount} completed
          </span>
        </div>
      )}

      {/* Tabs */}
      <div className="flex border-b border-border shrink-0">
        <button
          onClick={() => setActiveTab('in-progress')}
          className={`flex-1 px-4 py-2 text-sm font-medium transition-colors ${
            activeTab === 'in-progress'
              ? 'border-b-2 border-primary text-primary'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          In Progress ({activity?.inProgressCount || 0})
        </button>
        <button
          onClick={() => setActiveTab('completed')}
          className={`flex-1 px-4 py-2 text-sm font-medium transition-colors ${
            activeTab === 'completed'
              ? 'border-b-2 border-primary text-primary'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          Recent Completed ({activity?.recentCompleted?.length || 0})
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-4">
        {loading && !activity ? (
          <div className="flex items-center justify-center py-8">
            <RefreshCw className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : activeTab === 'in-progress' ? (
          <div className="space-y-2">
            {activity?.inProgress?.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                No trials in progress
              </div>
            ) : (
              activity?.inProgress?.map((trial, i) => (
                <div
                  key={i}
                  className={`p-3 rounded-lg transition-colors ${
                    trial.ageDurationMs > 3600000 ? 'bg-yellow-500/10 border border-yellow-500/30' : 'bg-muted/30'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <Play className="w-3 h-3 text-blue-500 animate-pulse" />
                    <span
                      className="font-medium text-sm truncate cursor-pointer hover:text-primary"
                      onClick={() => onTrialSelect?.(`${jobName}/${trial.trialName}`)}
                    >
                      {trial.taskName}
                    </span>
                    <button
                      onClick={() => onFilesSelect?.(`${jobName}/${trial.trialName}`)}
                      className="ml-auto p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-primary"
                      title="View trial files"
                    >
                      <FolderOpen className="w-4 h-4" />
                    </button>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    <div className="truncate">{trial.agent} / {trial.model.split('/').pop()}</div>
                    <div className="flex items-center gap-2 mt-1">
                      <Timer className="w-3 h-3" />
                      <span className={trial.ageDurationMs > 3600000 ? 'text-yellow-500' : ''}>
                        Running for {formatDuration(trial.ageDurationMs)}
                      </span>
                    </div>
                    {trial.startedAt && (
                      <div className="mt-1">Started: {new Date(trial.startedAt).toLocaleString()}</div>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        ) : (
          <div className="space-y-2">
            {activity?.recentCompleted?.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                No completed trials yet
              </div>
            ) : (
              activity?.recentCompleted?.map((trial, i) => (
                <div
                  key={i}
                  className="p-3 bg-muted/30 rounded-lg transition-colors"
                >
                  <div className="flex items-center gap-2">
                    {statusIcons[trial.status] || statusIcons.error}
                    <span
                      className="font-medium text-sm truncate cursor-pointer hover:text-primary"
                      onClick={() => onTrialSelect?.(`${jobName}/${trial.trialName}`)}
                    >
                      {trial.taskName}
                    </span>
                    <span className={`ml-auto text-xs font-medium ${statusColors[trial.status] || ''}`}>
                      {trial.status.toUpperCase()}
                    </span>
                    <button
                      onClick={() => onFilesSelect?.(`${jobName}/${trial.trialName}`)}
                      className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-primary"
                      title="View trial files"
                    >
                      <FolderOpen className="w-4 h-4" />
                    </button>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    <div className="truncate">{trial.agent} / {trial.model.split('/').pop()}</div>
                    <div className="flex items-center gap-4 mt-1">
                      <span>Finished: {formatTime(trial.finishedAt)}</span>
                      <span>Duration: {formatDuration(trial.durationMs)}</span>
                      {trial.reward !== null && (
                        <span className={trial.reward >= 1 ? 'text-green-500' : ''}>
                          Reward: {trial.reward.toFixed(2)}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  )
}

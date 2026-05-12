import { useState, useEffect } from 'react'
import {
  Terminal,
  Cpu,
  HardDrive,
  Clock,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  X,
  Play,
  RotateCcw,
  FileJson,
  Folder
} from 'lucide-react'

interface HarborJob {
  pid: string
  type: 'run' | 'resume' | 'unknown'
  command: string
  configFile: string | null
  outputDir: string | null
  jobName: string | null
  config: any | null
  cpu: string
  mem: string
  startedAt: string | null
}

interface HarborJobsPanelProps {
  onClose: () => void
}

export function HarborJobsPanel({ onClose }: HarborJobsPanelProps) {
  const [jobs, setJobs] = useState<HarborJob[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedJobs, setExpandedJobs] = useState<Set<string>>(new Set())

  const fetchJobs = async () => {
    try {
      const res = await fetch('/api/harbor-jobs')
      const data = await res.json()
      setJobs(data.jobs || [])
    } catch (err) {
      console.error('Failed to fetch harbor jobs:', err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchJobs()
    // Refresh every 2 seconds for CPU/mem updates
    const interval = setInterval(fetchJobs, 2000)
    return () => clearInterval(interval)
  }, [])

  const toggleExpand = (pid: string) => {
    setExpandedJobs(prev => {
      const next = new Set(prev)
      if (next.has(pid)) next.delete(pid)
      else next.add(pid)
      return next
    })
  }

  const formatStartTime = (startedAt: string | null): string => {
    if (!startedAt) return '-'
    // Parse format like "Tue Jan 27 20:13:10 2026" - server is in UTC
    try {
      // Add UTC timezone indicator since ps output is in server's UTC time
      const date = new Date(startedAt + ' UTC')
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    } catch {
      return startedAt
    }
  }

  return (
    <div className="border border-border rounded-lg bg-card overflow-hidden flex flex-col h-[calc(100vh-8rem)]">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border flex items-center justify-between bg-muted/30 shrink-0">
        <div className="flex items-center gap-2">
          <Terminal className="w-5 h-5" />
          <span className="font-medium">Harbor Jobs</span>
          <span className="text-xs text-muted-foreground">({jobs.length} running)</span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={fetchJobs} className="p-1.5 hover:bg-muted rounded" title="Refresh">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button onClick={onClose} className="p-1.5 hover:bg-muted rounded">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Jobs list */}
      <div className="flex-1 overflow-auto">
        {loading && jobs.length === 0 ? (
          <div className="flex items-center justify-center py-8">
            <RefreshCw className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : jobs.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            No harbor jobs running
          </div>
        ) : (
          <div className="divide-y divide-border">
            {jobs.map((job) => {
              const isExpanded = expandedJobs.has(job.pid)
              return (
                <div key={job.pid} className="bg-card">
                  {/* Job header */}
                  <button
                    onClick={() => toggleExpand(job.pid)}
                    className="w-full px-4 py-3 flex items-center gap-3 hover:bg-muted/50 text-left"
                  >
                    {isExpanded ? (
                      <ChevronDown className="w-4 h-4 shrink-0" />
                    ) : (
                      <ChevronRight className="w-4 h-4 shrink-0" />
                    )}

                    {job.type === 'run' ? (
                      <Play className="w-4 h-4 text-green-500 shrink-0" />
                    ) : (
                      <RotateCcw className="w-4 h-4 text-blue-500 shrink-0" />
                    )}

                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate">
                        {job.jobName || 'Unknown Job'}
                      </div>
                      <div className="text-xs text-muted-foreground flex items-center gap-3">
                        <span>PID: {job.pid}</span>
                        <span className="flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {formatStartTime(job.startedAt)}
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center gap-4 text-xs shrink-0">
                      <span className="flex items-center gap-1" title="CPU Usage">
                        <Cpu className="w-3 h-3 text-orange-500" />
                        {job.cpu}%
                      </span>
                      <span className="flex items-center gap-1" title="Memory Usage">
                        <HardDrive className="w-3 h-3 text-purple-500" />
                        {job.mem}%
                      </span>
                      <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                        job.type === 'run'
                          ? 'bg-green-500/20 text-green-600 dark:text-green-400'
                          : 'bg-blue-500/20 text-blue-600 dark:text-blue-400'
                      }`}>
                        {job.type.toUpperCase()}
                      </span>
                    </div>
                  </button>

                  {/* Expanded details */}
                  {isExpanded && (
                    <div className="px-4 py-3 bg-muted/20 border-t border-border space-y-3">
                      {/* Command */}
                      <div>
                        <div className="text-xs font-medium text-muted-foreground mb-1">Command</div>
                        <pre className="text-xs bg-muted/50 p-2 rounded overflow-x-auto whitespace-pre-wrap break-all">
                          {job.command}
                        </pre>
                      </div>

                      {/* Config file */}
                      {job.configFile && (
                        <div className="flex items-center gap-2 text-sm">
                          <FileJson className="w-4 h-4 text-yellow-500" />
                          <span className="text-muted-foreground">Config:</span>
                          <code className="text-xs bg-muted px-1.5 py-0.5 rounded">
                            {job.configFile}
                          </code>
                        </div>
                      )}

                      {/* Output dir */}
                      {job.outputDir && (
                        <div className="flex items-center gap-2 text-sm">
                          <Folder className="w-4 h-4 text-blue-500" />
                          <span className="text-muted-foreground">Output:</span>
                          <code className="text-xs bg-muted px-1.5 py-0.5 rounded">
                            {job.outputDir}
                          </code>
                        </div>
                      )}

                      {/* Config details */}
                      {job.config && (
                        <div>
                          <div className="text-xs font-medium text-muted-foreground mb-1">Config Details</div>
                          <div className="text-xs bg-muted/50 p-2 rounded space-y-1 max-h-48 overflow-auto">
                            {job.config.job_name && (
                              <div><span className="text-muted-foreground">job_name:</span> {job.config.job_name}</div>
                            )}
                            {job.config.jobs_dir && (
                              <div><span className="text-muted-foreground">jobs_dir:</span> {job.config.jobs_dir}</div>
                            )}
                            {job.config.n_attempts && (
                              <div><span className="text-muted-foreground">n_attempts:</span> {job.config.n_attempts}</div>
                            )}
                            {job.config.orchestrator?.n_concurrent_trials && (
                              <div><span className="text-muted-foreground">concurrent_trials:</span> {job.config.orchestrator.n_concurrent_trials}</div>
                            )}
                            {job.config.agents && Array.isArray(job.config.agents) && (
                              <div>
                                <span className="text-muted-foreground">agents:</span>
                                <div className="ml-2 mt-1 space-y-0.5">
                                  {job.config.agents.map((agent: any, idx: number) => (
                                    <div key={idx} className="text-muted-foreground">
                                      - {agent.name} ({agent.model_name?.split('/').pop() || 'unknown'})
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                            {job.config.datasets && Array.isArray(job.config.datasets) && (
                              <div>
                                <span className="text-muted-foreground">datasets:</span>
                                <div className="ml-2 mt-1 space-y-0.5">
                                  {job.config.datasets.map((ds: any, idx: number) => (
                                    <div key={idx} className="text-muted-foreground">
                                      - {ds.path?.split('/').pop() || 'unknown'} ({ds.task_names?.length || 'all'} tasks)
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                      )}
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

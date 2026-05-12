import { useState, useMemo } from 'react'
import type { ProcessedTrial, JobSummary } from './types/metrics'
import { formatCost, formatPercent, formatDuration } from './utils/formatters'
import {
  ChevronRight,
  ChevronDown,
  Search,
  Sun,
  Moon,
  Filter,
  Play,
  CheckCircle,
  Bot,
  RefreshCw,
  Loader2,
  AlertCircle,
  StopCircle,
  Activity,
  TrendingUp,
  FolderOpen,
  Folder,
  Eye,
  XCircle,
  AlertTriangle,
  Clock,
} from 'lucide-react'
import { TrialDetailPanel } from './components/TrialDetailPanel'
import { ResizablePanel } from './components/ResizablePanel'
import { HealthPanel } from './components/HealthPanel'
import { SystemInfoPanel } from './components/SystemInfoPanel'
import { JobActivityPanel } from './components/JobActivityPanel'
import { TrialFilesPanel } from './components/TrialFilesPanel'
import { HarborJobsPanel } from './components/HarborJobsPanel'
import { CompletionTimelineChart } from './components/CompletionTimelineChart'
import { JobTabbedPanel } from './components/JobTabbedPanel'
import { useMetrics } from './hooks/useMetrics'

// Type for model data in the hierarchy
type ModelData = { tasks: Map<string, ProcessedTrial[]>, stats: ModelRunStats }
// Type for job entries in sorted list
type JobEntry = [string, Map<string, ModelData>]

// Model run stats for the right panel
interface ModelRunStats {
  agent: string
  model: string
  jobName: string
  trials: ProcessedTrial[]
  passedCount: number
  failedCount: number
  errorCount: number
  passRate: number
  totalCost: number
  avgDuration: number
}

// Selection state can be job overview, model overview, trial detail, or system views
type SelectionType =
  | { type: 'none' }
  | { type: 'job'; jobName: string }
  | { type: 'model'; modelRun: ModelRunStats }
  | { type: 'trial'; trial: ProcessedTrial }
  | { type: 'system-info' }
  | { type: 'stale-trials' }
  | { type: 'containers'; initialTab?: 'all' | 'stuck' }
  | { type: 'job-activity'; jobName: string; agent?: string; model?: string }
  | { type: 'harbor-jobs' }
  | { type: 'timeline' }

function App() {
  const { data: metrics, isLoading, error, lastUpdated, refetch } = useMetrics({ pollInterval: 5000 })
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedJob, setSelectedJob] = useState<string | null>(null)
  const [expandedJobs, setExpandedJobs] = useState<Set<string>>(new Set())
  const [expandedModels, setExpandedModels] = useState<Set<string>>(new Set())
  const [expandedJobGroups, setExpandedJobGroups] = useState<Set<string>>(new Set(['with-skills', 'without-skills', 'pass-1', 'pass-2', 'pass-3']))
  const [jobGroupBy, setJobGroupBy] = useState<'none' | 'skills' | 'pass'>('skills')
  const [hideMhc, setHideMhc] = useState(false)
  const [statusFilter, setStatusFilter] = useState<string[]>([])
  const [selection, setSelection] = useState<SelectionType>({ type: 'none' })
  const [filesModalPath, setFilesModalPath] = useState<string | null>(null) // Separate state for files modal
  const [jobSortBy, setJobSortBy] = useState<'name' | 'passRate' | 'lastModified' | 'status'>('lastModified')
  const [completedAtBottom, setCompletedAtBottom] = useState(true)
  const [isDark, setIsDark] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
  )

  if (isDark) {
    document.documentElement.classList.add('dark')
  } else {
    document.documentElement.classList.remove('dark')
  }

  // Create job summary map from dynamic data
  const jobSummaryMap = useMemo(() => {
    if (!metrics) return new Map<string, JobSummary>()
    return new Map(metrics.jobs.map(j => [j.jobName, j]))
  }, [metrics])

  // Build hierarchical data: Jobs > (Agent+Model) > Tasks
  const hierarchy = useMemo(() => {
    // Job -> ModelKey -> TaskName -> Trials
    const jobs = new Map<string, Map<string, Map<string, ProcessedTrial[]>>>()

    if (!metrics) return jobs

    for (const trial of metrics.trials) {
      if (!jobs.has(trial.jobName)) {
        jobs.set(trial.jobName, new Map())
      }
      const models = jobs.get(trial.jobName)!
      const modelKey = `${trial.agent}__${trial.model}`

      if (!models.has(modelKey)) {
        models.set(modelKey, new Map())
      }
      const tasks = models.get(modelKey)!

      if (!tasks.has(trial.taskName)) {
        tasks.set(trial.taskName, [])
      }
      tasks.get(trial.taskName)!.push(trial)
    }

    return jobs
  }, [metrics])

  // Filter and compute stats
  const filteredHierarchy = useMemo(() => {
    const q = searchQuery.toLowerCase()
    const filtered = new Map<string, Map<string, { tasks: Map<string, ProcessedTrial[]>, stats: ModelRunStats }>>()

    hierarchy.forEach((models, jobName) => {
      if (selectedJob && jobName !== selectedJob) return

      const filteredModels = new Map<string, { tasks: Map<string, ProcessedTrial[]>, stats: ModelRunStats }>()

      models.forEach((tasks, modelKey) => {
        const [agent, model] = modelKey.split('__')
        const filteredTasks = new Map<string, ProcessedTrial[]>()
        const allTrials: ProcessedTrial[] = []

        tasks.forEach((trials, taskName) => {
          const filteredTrials = trials.filter(trial => {
            if (statusFilter.length > 0 && !statusFilter.includes(trial.status)) return false
            if (q && !trial.taskName.toLowerCase().includes(q) &&
                !trial.agent.toLowerCase().includes(q) &&
                !trial.model.toLowerCase().includes(q)) return false
            return true
          })
          if (filteredTrials.length > 0) {
            filteredTasks.set(taskName, filteredTrials)
            allTrials.push(...filteredTrials)
          }
        })

        if (filteredTasks.size > 0) {
          // Count passes based on reward >= 1 (regardless of error status)
          const passedCount = allTrials.filter(t => (t.reward ?? 0) >= 1.0).length
          const errorCount = allTrials.filter(t => t.exceptionInfo !== null && (t.reward ?? 0) < 1.0).length
          const failedCount = allTrials.length - passedCount - errorCount
          const totalCost = allTrials.reduce((sum, t) => sum + (t.costUsd ?? 0), 0)
          const avgDuration = allTrials.reduce((sum, t) => sum + t.durationMs, 0) / allTrials.length
          // Calculate MEAN REWARD (sum of rewards / trials) to match old monitor
          const totalReward = allTrials.reduce((sum, t) => sum + (t.reward ?? 0), 0)
          const meanReward = totalReward / allTrials.length

          filteredModels.set(modelKey, {
            tasks: filteredTasks,
            stats: {
              agent,
              model,
              jobName,
              trials: allTrials,
              passedCount,
              failedCount,
              errorCount,
              passRate: meanReward, // Use mean reward instead of binary pass rate
              totalCost,
              avgDuration,
            }
          })
        }
      })

      if (filteredModels.size > 0) {
        filtered.set(jobName, filteredModels)
      }
    })

    return filtered
  }, [hierarchy, searchQuery, selectedJob, statusFilter])

  // Sort jobs based on selected sort option
  // Include ALL jobs from metrics.jobs, not just those with completed trials
  const sortedJobEntries = useMemo(() => {
    // Start with jobs from filteredHierarchy
    const entriesMap = new Map(filteredHierarchy.entries())

    // Add jobs that have no completed trials (not in hierarchy)
    // These will show with empty models
    if (metrics?.jobs) {
      for (const job of metrics.jobs) {
        if (!entriesMap.has(job.jobName) && (!selectedJob || job.jobName === selectedJob)) {
          entriesMap.set(job.jobName, new Map())
        }
      }
    }

    let entries = Array.from(entriesMap.entries())

    // Filter out MHC jobs if hideMhc is enabled
    if (hideMhc) {
      entries = entries.filter(([jobName]) => !jobName.toLowerCase().includes('mhc'))
    }

    return entries.sort((a, b) => {
      const [jobNameA, modelsA] = a
      const [jobNameB, modelsB] = b
      const summaryA = jobSummaryMap.get(jobNameA)
      const summaryB = jobSummaryMap.get(jobNameB)

      // Double sorting: if enabled, completed jobs go to bottom first
      if (completedAtBottom) {
        const isRunningA = summaryA?.jobStatus === 'running' ? 0 : 1
        const isRunningB = summaryB?.jobStatus === 'running' ? 0 : 1
        if (isRunningA !== isRunningB) return isRunningA - isRunningB
      }

      // Calculate stats for sorting
      let passRateA = 0, passRateB = 0
      let totalA = 0, totalB = 0
      modelsA.forEach(({ stats: s }) => {
        passRateA += s.trials.reduce((sum, t) => sum + (t.reward ?? 0), 0)
        totalA += s.trials.length
      })
      modelsB.forEach(({ stats: s }) => {
        passRateB += s.trials.reduce((sum, t) => sum + (t.reward ?? 0), 0)
        totalB += s.trials.length
      })
      passRateA = totalA > 0 ? passRateA / totalA : 0
      passRateB = totalB > 0 ? passRateB / totalB : 0

      // Secondary sort based on selected option
      switch (jobSortBy) {
        case 'name':
          return jobNameA.localeCompare(jobNameB)
        case 'passRate':
          return passRateB - passRateA // Highest first
        case 'status':
          // Running first, then by name
          const statusA = summaryA?.jobStatus === 'running' ? 0 : 1
          const statusB = summaryB?.jobStatus === 'running' ? 0 : 1
          if (statusA !== statusB) return statusA - statusB
          return jobNameA.localeCompare(jobNameB)
        case 'lastModified':
        default:
          // Most recently created first (by job start time)
          const createdA = summaryA?.startedAt || ''
          const createdB = summaryB?.startedAt || ''
          return createdB.localeCompare(createdA)
      }
    })
  }, [filteredHierarchy, jobSummaryMap, jobSortBy, completedAtBottom, metrics?.jobs, selectedJob, hideMhc])

  // Group jobs by with/without skills OR by pass number
  const groupedJobs = useMemo(() => {
    // Parse job name to extract group info
    // Patterns like: main-with-skills-pass1, main-without-skills-pass2, etc.
    const parseJobName = (jobName: string) => {
      const withSkillsMatch = jobName.match(/(.+)-(with-skills)(?:-pass(\d+))?$/)
      const withoutSkillsMatch = jobName.match(/(.+)-(without-skills)(?:-pass(\d+))?$/)

      if (withSkillsMatch) {
        return {
          prefix: withSkillsMatch[1],
          skillsGroup: 'with-skills' as const,
          passNumber: withSkillsMatch[3] ? parseInt(withSkillsMatch[3]) : null,
        }
      }
      if (withoutSkillsMatch) {
        return {
          prefix: withoutSkillsMatch[1],
          skillsGroup: 'without-skills' as const,
          passNumber: withoutSkillsMatch[3] ? parseInt(withoutSkillsMatch[3]) : null,
        }
      }
      return null
    }

    // If no grouping, return all jobs as ungrouped
    if (jobGroupBy === 'none') {
      return { groups: new Map<string, { jobs: JobEntry[], label: string, color: string }>(), ungrouped: sortedJobEntries as JobEntry[] }
    }

    // Group jobs
    const groups = new Map<string, {
      jobs: JobEntry[]
      label: string
      color: string
    }>()
    const ungrouped: JobEntry[] = []

    for (const entry of sortedJobEntries as JobEntry[]) {
      const [jobName] = entry
      const parsed = parseJobName(jobName)

      if (parsed) {
        let groupKey: string
        let label: string
        let color: string

        if (jobGroupBy === 'skills') {
          groupKey = parsed.skillsGroup
          label = groupKey === 'with-skills' ? 'With Skills' : 'Without Skills'
          color = groupKey === 'with-skills' ? 'text-purple-500' : 'text-orange-500'
        } else {
          // Group by pass number
          if (parsed.passNumber !== null) {
            groupKey = `pass-${parsed.passNumber}`
            label = `Pass ${parsed.passNumber}`
            color = ['text-blue-500', 'text-green-500', 'text-yellow-500', 'text-pink-500', 'text-cyan-500'][
              (parsed.passNumber - 1) % 5
            ]
          } else {
            ungrouped.push(entry)
            continue
          }
        }

        if (!groups.has(groupKey)) {
          groups.set(groupKey, { jobs: [], label, color })
        }
        groups.get(groupKey)!.jobs.push(entry)
      } else {
        ungrouped.push(entry)
      }
    }

    // Sort jobs within each group
    groups.forEach(group => {
      group.jobs.sort((a, b) => {
        const parsedA = parseJobName(a[0])
        const parsedB = parseJobName(b[0])
        if (jobGroupBy === 'skills') {
          // Sort by pass number within skills group
          const passA = parsedA?.passNumber ?? 0
          const passB = parsedB?.passNumber ?? 0
          return passA - passB
        } else {
          // Sort by skills within pass group
          const skillsA = parsedA?.skillsGroup ?? ''
          const skillsB = parsedB?.skillsGroup ?? ''
          return skillsA.localeCompare(skillsB)
        }
      })
    })

    // Sort groups by key
    const sortedGroups = new Map([...groups.entries()].sort((a, b) => {
      if (jobGroupBy === 'pass') {
        // Sort pass groups numerically
        const numA = parseInt(a[0].replace('pass-', '')) || 0
        const numB = parseInt(b[0].replace('pass-', '')) || 0
        return numA - numB
      }
      return a[0].localeCompare(b[0])
    }))

    return { groups: sortedGroups, ungrouped }
  }, [sortedJobEntries, jobGroupBy])

  const toggleJobGroup = (groupKey: string) => {
    setExpandedJobGroups(prev => {
      const next = new Set(prev)
      if (next.has(groupKey)) next.delete(groupKey)
      else next.add(groupKey)
      return next
    })
  }

  // Overall stats
  const stats = useMemo(() => {
    let total = 0, passed = 0, failed = 0, errored = 0, cost = 0
    filteredHierarchy.forEach(models => {
      models.forEach(({ stats: s }) => {
        total += s.trials.length
        passed += s.passedCount
        failed += s.failedCount
        errored += s.errorCount
        cost += s.totalCost
      })
    })
    return { total, passed, failed, errored, cost }
  }, [filteredHierarchy])

  const toggleJob = (jobName: string) => {
    setExpandedJobs(prev => {
      const next = new Set(prev)
      if (next.has(jobName)) next.delete(jobName)
      else next.add(jobName)
      return next
    })
  }

  const toggleModel = (key: string) => {
    setExpandedModels(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const toggleStatus = (status: string) => {
    setStatusFilter(prev =>
      prev.includes(status) ? prev.filter(s => s !== status) : [...prev, status]
    )
  }

  const allStatuses = ['pass', 'fail', 'error', 'timeout']

  // Loading state
  if (isLoading && !metrics) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="w-8 h-8 animate-spin mx-auto mb-4 text-primary" />
          <p className="text-muted-foreground">Loading metrics...</p>
        </div>
      </div>
    )
  }

  // Error state
  if (error && !metrics) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center max-w-md">
          <AlertCircle className="w-8 h-8 mx-auto mb-4 text-red-500" />
          <p className="text-red-500 font-medium mb-2">Failed to load metrics</p>
          <p className="text-muted-foreground text-sm mb-4">{error}</p>
          <button
            onClick={refetch}
            className="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm hover:bg-primary/90"
          >
            Retry
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-card border-b border-border">
        <div className="max-w-7xl mx-auto px-4 py-3">
          <div className="flex items-center gap-4">
            <h1 className="text-lg font-semibold">SkillsBench Metrics</h1>

            {/* Search */}
            <div className="relative flex-1 max-w-md">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <input
                type="text"
                placeholder="Search..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-10 pr-4 py-1.5 bg-background border border-border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>

            {/* Job filter */}
            <select
              value={selectedJob ?? ''}
              onChange={(e) => setSelectedJob(e.target.value || null)}
              className="px-3 py-1.5 bg-background border border-border rounded-md text-sm"
            >
              <option value="">All Jobs</option>
              {metrics?.jobs.map(j => (
                <option key={j.jobName} value={j.jobName}>{j.jobName}</option>
              ))}
            </select>

            {/* Group by dropdown */}
            <select
              value={jobGroupBy}
              onChange={(e) => setJobGroupBy(e.target.value as typeof jobGroupBy)}
              className="px-3 py-1.5 bg-background border border-border rounded-md text-sm"
            >
              <option value="none">Group: None</option>
              <option value="skills">Group: Skills</option>
              <option value="pass">Group: Pass #</option>
            </select>

            {/* Sort dropdown */}
            <select
              value={jobSortBy}
              onChange={(e) => setJobSortBy(e.target.value as typeof jobSortBy)}
              className="px-3 py-1.5 bg-background border border-border rounded-md text-sm"
            >
              <option value="lastModified">Sort: Created</option>
              <option value="name">Sort: Name</option>
              <option value="passRate">Sort: Pass Rate</option>
              <option value="status">Sort: Status</option>
            </select>

            {/* Completed at bottom toggle */}
            <label className="flex items-center gap-1.5 text-sm text-muted-foreground cursor-pointer">
              <input
                type="checkbox"
                checked={completedAtBottom}
                onChange={(e) => setCompletedAtBottom(e.target.checked)}
                className="w-4 h-4 rounded border-border"
              />
              <span>Done ↓</span>
            </label>

            {/* Hide MHC toggle */}
            <label className="flex items-center gap-1.5 text-sm text-muted-foreground cursor-pointer">
              <input
                type="checkbox"
                checked={hideMhc}
                onChange={(e) => setHideMhc(e.target.checked)}
                className="w-4 h-4 rounded border-border"
              />
              <span>Hide MHC</span>
            </label>

            {/* Timeline chart button */}
            <button
              onClick={() => setSelection({ type: 'timeline' })}
              className={`p-2 hover:bg-muted rounded-md ${selection.type === 'timeline' ? 'bg-muted' : ''}`}
              title="Completion timeline"
            >
              <TrendingUp className="w-4 h-4" />
            </button>

            {/* Refresh button */}
            <button
              onClick={refetch}
              className="p-2 hover:bg-muted rounded-md"
              title="Refresh now"
            >
              <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
            </button>

            {/* Theme toggle */}
            <button
              onClick={() => setIsDark(!isDark)}
              className="p-2 hover:bg-muted rounded-md"
            >
              {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>
          </div>

          {/* Status filters & stats */}
          <div className="flex items-center gap-4 mt-3">
            <div className="flex items-center gap-1">
              <Filter className="w-4 h-4 text-muted-foreground" />
              {allStatuses.map(status => (
                <button
                  key={status}
                  onClick={() => toggleStatus(status)}
                  className={`px-2 py-0.5 text-xs rounded ${
                    statusFilter.includes(status) || statusFilter.length === 0
                      ? `badge-${status}`
                      : 'bg-muted text-muted-foreground'
                  }`}
                >
                  {status}
                </button>
              ))}
            </div>

            <div className="flex-1" />

            <div className="flex items-center gap-4 text-sm">
              <span>{stats.total} trials</span>
              <span className="text-green-600 dark:text-green-400">{stats.passed} pass</span>
              <span className="text-red-600 dark:text-red-400">{stats.failed} fail</span>
              <span className="text-orange-600 dark:text-orange-400">{stats.errored} error</span>
              <span className="text-muted-foreground">{formatCost(stats.cost)}</span>
              {lastUpdated && (
                <span className="text-xs text-muted-foreground">
                  Updated {lastUpdated.toLocaleTimeString()}
                </span>
              )}
            </div>
          </div>
        </div>
      </header>

      <div className="h-[calc(100vh-7rem)]">
        <ResizablePanel
          defaultLeftWidth={30}
          minLeftWidth={20}
          maxLeftWidth={50}
          left={
            <div className="h-full overflow-auto p-4 space-y-2">
              {/* System Health Panel */}
              <HealthPanel onSelect={(type, containerTab) => {
                if (type === 'containers') {
                  setSelection({ type, initialTab: containerTab })
                } else {
                  setSelection({ type })
                }
              }} />

              {/* Render grouped jobs */}
              {Array.from(groupedJobs.groups.entries()).map(([groupKey, groupData]) => {
                const isGroupExpanded = expandedJobGroups.has(groupKey)
                const groupLabel = groupData.label
                const groupColor = groupData.color

                // Calculate group-level stats
                let groupRewardSum = 0, groupTotal = 0, groupRunning = 0, groupCompleted = 0
                groupData.jobs.forEach((entry: JobEntry) => {
                  const [jn, mdls] = entry
                  const jobSum = jobSummaryMap.get(jn)
                  if (jobSum?.jobStatus === 'running') groupRunning++
                  else groupCompleted++
                  mdls.forEach((m: ModelData) => {
                    groupRewardSum += m.stats.trials.reduce((sum: number, t: ProcessedTrial) => sum + (t.reward ?? 0), 0)
                    groupTotal += m.stats.trials.length
                  })
                })
                const groupMeanReward = groupTotal > 0 ? groupRewardSum / groupTotal : 0

                return (
                  <div key={groupKey} className="space-y-2">
                    {/* Group header */}
                    <button
                      onClick={() => toggleJobGroup(groupKey)}
                      className="w-full px-3 py-2 flex items-center gap-2 hover:bg-muted/50 rounded-lg transition-colors"
                    >
                      {isGroupExpanded ? <FolderOpen className={`w-4 h-4 ${groupColor}`} /> : <Folder className={`w-4 h-4 ${groupColor}`} />}
                      <span className={`font-medium ${groupColor}`}>{groupLabel}</span>
                      <span className="text-xs text-muted-foreground">
                        ({groupData.jobs.length} jobs)
                      </span>
                      <div className="ml-auto flex items-center gap-3 text-xs">
                        {groupRunning > 0 && (
                          <span className="flex items-center gap-1 text-green-500">
                            <Play className="w-3 h-3" />
                            {groupRunning}
                          </span>
                        )}
                        <span className="text-muted-foreground">{groupTotal} trials</span>
                        <span className={groupMeanReward >= 0.5 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}>
                          {formatPercent(groupMeanReward)}
                        </span>
                        {isGroupExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                      </div>
                    </button>

                    {/* Jobs in this group */}
                    {isGroupExpanded && (
                      <div className="pl-2 space-y-2">
                        {groupData.jobs.map((entry: JobEntry) => {
                          const [jobName, models] = entry
                          const jobSummary = jobSummaryMap.get(jobName)
                          const isRunning = jobSummary?.jobStatus === 'running'
                          const expectedTrials = jobSummary?.expectedTrials || 0
                          const completedTrials = jobSummary?.completedTrials || 0
                          const progress = expectedTrials > 0 ? (completedTrials / expectedTrials) * 100 : 100
                          const isJobExpanded = expandedJobs.has(jobName)

                          // Extract display label based on grouping mode
                          const passMatch = jobName.match(/-pass(\d+)$/)
                          const skillsMatch = jobName.match(/-(with-skills|without-skills)/)
                          let passLabel: string
                          if (jobGroupBy === 'skills' && passMatch) {
                            passLabel = `Pass ${passMatch[1]}`
                          } else if (jobGroupBy === 'pass' && skillsMatch) {
                            passLabel = skillsMatch[1] === 'with-skills' ? 'With Skills' : 'Without Skills'
                          } else {
                            passLabel = jobName
                          }

                          let jobRewardSum = 0, jobTotal = 0, jobCost = 0
                          models.forEach((m: ModelData) => {
                            jobRewardSum += m.stats.trials.reduce((sum: number, t: ProcessedTrial) => sum + (t.reward ?? 0), 0)
                            jobTotal += m.stats.trials.length
                            jobCost += m.stats.totalCost
                          })
                          const jobMeanReward = jobTotal > 0 ? jobRewardSum / jobTotal : 0

                          return (
                            <div key={jobName} className="border border-border rounded-lg overflow-hidden bg-card">
                              <button
                                onClick={() => {
                                  toggleJob(jobName)
                                  setSelection({ type: 'job', jobName })
                                }}
                                className={`w-full px-4 py-3 hover:bg-muted/50 transition-colors text-left ${
                                  selection.type === 'job' && selection.jobName === jobName ? 'bg-primary/10' : ''
                                }`}
                              >
                                <div className="flex items-center gap-3">
                                  {isJobExpanded ? <ChevronDown className="w-4 h-4 flex-shrink-0" /> : <ChevronRight className="w-4 h-4 flex-shrink-0" />}
                                  <span className="font-medium truncate">{passLabel}</span>
                                  <span className="text-xs text-muted-foreground truncate">({jobName})</span>
                                  <span className={`ml-auto flex items-center gap-1 px-2 py-0.5 text-xs rounded-full font-medium ${
                                    isRunning
                                      ? 'bg-green-500/20 text-green-600 dark:text-green-400'
                                      : 'bg-blue-500/20 text-blue-600 dark:text-blue-400'
                                  }`}>
                                    {isRunning ? <Play className="w-3 h-3" /> : <CheckCircle className="w-3 h-3" />}
                                    {isRunning ? 'RUNNING' : 'COMPLETED'}
                                  </span>
                                  {isRunning && (
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        if (confirm(`Stop job "${jobName}" and mark all incomplete trials as done?`)) {
                                          fetch('/api/stop-job', {
                                            method: 'POST',
                                            headers: { 'Content-Type': 'application/json' },
                                            body: JSON.stringify({ jobName })
                                          })
                                            .then(res => res.json())
                                            .then(data => {
                                              if (data.success) {
                                                alert(`Stopped job: marked ${data.markedCount} incomplete trials as done`)
                                                refetch()
                                              } else {
                                                alert(`Error: ${data.error}`)
                                              }
                                            })
                                            .catch(err => alert(`Error: ${err.message}`))
                                        }
                                      }}
                                      className="ml-2 p-1 rounded hover:bg-red-500/20 text-red-500 transition-colors"
                                      title="Stop job and mark incomplete trials as done"
                                    >
                                      <StopCircle className="w-4 h-4" />
                                    </button>
                                  )}
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      setSelection({ type: 'job', jobName })
                                    }}
                                    className="ml-2 p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                                    title="View job details"
                                  >
                                    <Eye className="w-4 h-4" />
                                  </button>
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      setSelection({ type: 'job-activity', jobName })
                                    }}
                                    className="ml-2 p-1 rounded hover:bg-blue-500/20 text-blue-500 transition-colors"
                                    title="View trial activity"
                                  >
                                    <Activity className="w-4 h-4" />
                                  </button>
                                </div>
                                <div className="mt-2 flex items-center gap-3">
                                  <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
                                    <div
                                      className={`h-full transition-all ${isRunning ? 'bg-green-500' : 'bg-blue-500'}`}
                                      style={{ width: `${progress}%` }}
                                    />
                                  </div>
                                  <span className="text-xs text-muted-foreground whitespace-nowrap">
                                    {completedTrials}/{expectedTrials}
                                  </span>
                                </div>
                                <div className="mt-2 flex items-center gap-4 text-xs text-muted-foreground">
                                  <span>{models.size} model runs</span>
                                  <span>{jobTotal} trials</span>
                                  <span className={jobMeanReward >= 0.5 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}>
                                    {formatPercent(jobMeanReward)}
                                  </span>
                                  {jobCost > 0 && (
                                    <span className="ml-auto">{formatCost(jobCost)}</span>
                                  )}
                                </div>
                              </button>
                              {isJobExpanded && (
                                <div className="border-t border-border">
                                  {Array.from(models.entries()).map(([modelKey, modelData]: [string, ModelData]) => {
                                    const { tasks, stats: modelStats } = modelData
                                    const fullKey = `${jobName}/${modelKey}`
                                    const isModelExpanded = expandedModels.has(fullKey)
                                    const shortModel = modelStats.model.split('@')[0].replace('vertex_ai/', '').replace('openai/', '')
                                    return (
                                      <div key={fullKey}>
                                        <button
                                          onClick={() => {
                                            toggleModel(fullKey)
                                            setSelection({ type: 'model', modelRun: modelStats })
                                          }}
                                          className={`w-full px-4 py-2 pl-8 flex items-center gap-3 hover:bg-muted/50 transition-colors border-b border-border/50 ${
                                            selection.type === 'model' && selection.modelRun.agent === modelStats.agent && selection.modelRun.model === modelStats.model && selection.modelRun.jobName === modelStats.jobName ? 'bg-primary/10' : ''
                                          }`}
                                        >
                                          {isModelExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                                          <Bot className="w-4 h-4 text-muted-foreground" />
                                          <div className="flex flex-col items-start min-w-0">
                                            <span className="text-sm font-medium truncate">{modelStats.agent}</span>
                                            <span className="text-xs text-muted-foreground truncate">{shortModel}</span>
                                          </div>
                                          <div className="ml-auto flex items-center gap-3 text-xs">
                                            <span className="text-green-600 dark:text-green-400">{modelStats.passedCount}</span>
                                            <span className="text-muted-foreground">/</span>
                                            <span className="text-red-600 dark:text-red-400">{modelStats.failedCount + modelStats.errorCount}</span>
                                            <span className={modelStats.passRate >= 0.5 ? 'text-green-600 dark:text-green-400 font-medium' : 'text-red-600 dark:text-red-400 font-medium'}>
                                              {formatPercent(modelStats.passRate)}
                                            </span>
                                            <button
                                              onClick={(e) => {
                                                e.stopPropagation()
                                                setSelection({ type: 'job-activity', jobName, agent: modelStats.agent, model: modelStats.model })
                                              }}
                                              className="p-1 rounded hover:bg-blue-500/20 text-blue-500 transition-colors"
                                              title="View trial activity for this agent/model"
                                            >
                                              <Activity className="w-3 h-3" />
                                            </button>
                                          </div>
                                        </button>
                                        {isModelExpanded && (
                                          <div className="bg-muted/30">
                                            {Array.from(tasks.entries()).map(([taskName, trials]: [string, ProcessedTrial[]]) => {
                                              const trial = trials[0]
                                              const taskPassed = trials.filter((t: ProcessedTrial) => t.status === 'pass').length
                                              return (
                                                <button
                                                  key={`${fullKey}/${taskName}`}
                                                  onClick={() => setSelection({ type: 'trial', trial })}
                                                  className={`w-full px-4 py-2 pl-16 flex items-center gap-3 text-sm hover:bg-muted/50 transition-colors border-b border-border/30 last:border-b-0 ${
                                                    selection.type === 'trial' && selection.trial.id === trial.id ? 'bg-primary/10' : ''
                                                  }`}
                                                >
                                                  <span className={`badge-${trial.status} px-1.5 py-0.5 text-xs rounded`}>{trial.status}</span>
                                                  <span className="truncate flex-1 text-left">{taskName}</span>
                                                  {trials.length > 1 && <span className="text-xs text-muted-foreground">{taskPassed}/{trials.length}</span>}
                                                  {trial.reward !== null && (
                                                    <span className={`text-xs ${trial.reward >= 1 ? 'text-green-600 dark:text-green-400' : ''}`}>
                                                      {trial.reward.toFixed(2)}
                                                    </span>
                                                  )}
                                                </button>
                                              )
                                            })}
                                          </div>
                                        )}
                                      </div>
                                    )
                                  })}
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )
              })}

              {/* Render ungrouped jobs */}
              {groupedJobs.ungrouped.map(([jobName, models]) => {
                const jobSummary = jobSummaryMap.get(jobName)
                const isRunning = jobSummary?.jobStatus === 'running'
                const expectedTrials = jobSummary?.expectedTrials || 0
                const completedTrials = jobSummary?.completedTrials || 0
                const progress = expectedTrials > 0 ? (completedTrials / expectedTrials) * 100 : 100
                const isJobExpanded = expandedJobs.has(jobName)

                let jobRewardSum = 0, jobTotal = 0, jobCost = 0
                models.forEach(({ stats: s }) => {
                  jobRewardSum += s.trials.reduce((sum, t) => sum + (t.reward ?? 0), 0)
                  jobTotal += s.trials.length
                  jobCost += s.totalCost
                })
                const jobMeanReward = jobTotal > 0 ? jobRewardSum / jobTotal : 0

                return (
                  <div key={jobName} className="border border-border rounded-lg overflow-hidden bg-card">
                    <button
                      onClick={() => {
                        toggleJob(jobName)
                        setSelection({ type: 'job', jobName })
                      }}
                      className={`w-full px-4 py-3 hover:bg-muted/50 transition-colors text-left ${
                        selection.type === 'job' && selection.jobName === jobName ? 'bg-primary/10' : ''
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        {isJobExpanded ? <ChevronDown className="w-4 h-4 flex-shrink-0" /> : <ChevronRight className="w-4 h-4 flex-shrink-0" />}
                        <span className="font-medium truncate">{jobName}</span>
                        <span className={`ml-auto flex items-center gap-1 px-2 py-0.5 text-xs rounded-full font-medium ${
                          isRunning
                            ? 'bg-green-500/20 text-green-600 dark:text-green-400'
                            : 'bg-blue-500/20 text-blue-600 dark:text-blue-400'
                        }`}>
                          {isRunning ? <Play className="w-3 h-3" /> : <CheckCircle className="w-3 h-3" />}
                          {isRunning ? 'RUNNING' : 'COMPLETED'}
                        </span>
                        {isRunning && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              if (confirm(`Stop job "${jobName}" and mark all incomplete trials as done?`)) {
                                fetch('/api/stop-job', {
                                  method: 'POST',
                                  headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify({ jobName })
                                })
                                  .then(res => res.json())
                                  .then(data => {
                                    if (data.success) {
                                      alert(`Stopped job: marked ${data.markedCount} incomplete trials as done`)
                                      refetch()
                                    } else {
                                      alert(`Error: ${data.error}`)
                                    }
                                  })
                                  .catch(err => alert(`Error: ${err.message}`))
                              }
                            }}
                            className="ml-2 p-1 rounded hover:bg-red-500/20 text-red-500 transition-colors"
                            title="Stop job and mark incomplete trials as done"
                          >
                            <StopCircle className="w-4 h-4" />
                          </button>
                        )}
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            setSelection({ type: 'job', jobName })
                          }}
                          className="ml-2 p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                          title="View job details"
                        >
                          <Eye className="w-4 h-4" />
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            setSelection({ type: 'job-activity', jobName })
                          }}
                          className="ml-2 p-1 rounded hover:bg-blue-500/20 text-blue-500 transition-colors"
                          title="View trial activity"
                        >
                          <Activity className="w-4 h-4" />
                        </button>
                      </div>
                      <div className="mt-2 flex items-center gap-3">
                        <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
                          <div
                            className={`h-full transition-all ${isRunning ? 'bg-green-500' : 'bg-blue-500'}`}
                            style={{ width: `${progress}%` }}
                          />
                        </div>
                        <span className="text-xs text-muted-foreground whitespace-nowrap">
                          {completedTrials}/{expectedTrials}
                        </span>
                      </div>
                      <div className="mt-2 flex items-center gap-4 text-xs text-muted-foreground">
                        <span>{models.size} model runs</span>
                        <span>{jobTotal} trials</span>
                        <span className={jobMeanReward >= 0.5 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}>
                          {formatPercent(jobMeanReward)}
                        </span>
                        {jobCost > 0 && (
                          <span className="ml-auto">{formatCost(jobCost)}</span>
                        )}
                      </div>
                    </button>
                    {isJobExpanded && (
                      <div className="border-t border-border">
                        {Array.from(models.entries()).map(([modelKey, { tasks, stats: modelStats }]) => {
                          const fullKey = `${jobName}/${modelKey}`
                          const isModelExpanded = expandedModels.has(fullKey)
                          const shortModel = modelStats.model.split('@')[0].replace('vertex_ai/', '').replace('openai/', '')
                          return (
                            <div key={fullKey}>
                              <button
                                onClick={() => {
                                  toggleModel(fullKey)
                                  setSelection({ type: 'model', modelRun: modelStats })
                                }}
                                className={`w-full px-4 py-2 pl-8 flex items-center gap-3 hover:bg-muted/50 transition-colors border-b border-border/50 ${
                                  selection.type === 'model' && selection.modelRun.agent === modelStats.agent && selection.modelRun.model === modelStats.model && selection.modelRun.jobName === modelStats.jobName ? 'bg-primary/10' : ''
                                }`}
                              >
                                {isModelExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                                <Bot className="w-4 h-4 text-muted-foreground" />
                                <div className="flex flex-col items-start min-w-0">
                                  <span className="text-sm font-medium truncate">{modelStats.agent}</span>
                                  <span className="text-xs text-muted-foreground truncate">{shortModel}</span>
                                </div>
                                <div className="ml-auto flex items-center gap-3 text-xs">
                                  <span className="text-green-600 dark:text-green-400">{modelStats.passedCount}</span>
                                  <span className="text-muted-foreground">/</span>
                                  <span className="text-red-600 dark:text-red-400">{modelStats.failedCount + modelStats.errorCount}</span>
                                  <span className={modelStats.passRate >= 0.5 ? 'text-green-600 dark:text-green-400 font-medium' : 'text-red-600 dark:text-red-400 font-medium'}>
                                    {formatPercent(modelStats.passRate)}
                                  </span>
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      setSelection({ type: 'job-activity', jobName, agent: modelStats.agent, model: modelStats.model })
                                    }}
                                    className="p-1 rounded hover:bg-blue-500/20 text-blue-500 transition-colors"
                                    title="View trial activity for this agent/model"
                                  >
                                    <Activity className="w-3 h-3" />
                                  </button>
                                </div>
                              </button>
                              {isModelExpanded && (
                                <div className="bg-muted/30">
                                  {Array.from(tasks.entries()).map(([taskName, trials]) => {
                                    const trial = trials[0]
                                    const taskPassed = trials.filter(t => t.status === 'pass').length
                                    return (
                                      <button
                                        key={`${fullKey}/${taskName}`}
                                        onClick={() => setSelection({ type: 'trial', trial })}
                                        className={`w-full px-4 py-2 pl-16 flex items-center gap-3 text-sm hover:bg-muted/50 transition-colors border-b border-border/30 last:border-b-0 ${
                                          selection.type === 'trial' && selection.trial.id === trial.id ? 'bg-primary/10' : ''
                                        }`}
                                      >
                                        <span className={`badge-${trial.status} px-1.5 py-0.5 text-xs rounded`}>{trial.status}</span>
                                        <span className="truncate flex-1 text-left">{taskName}</span>
                                        {trials.length > 1 && <span className="text-xs text-muted-foreground">{taskPassed}/{trials.length}</span>}
                                        {trial.reward !== null && (
                                          <span className={`text-xs ${trial.reward >= 1 ? 'text-green-600 dark:text-green-400' : ''}`}>
                                            {trial.reward.toFixed(2)}
                                          </span>
                                        )}
                                      </button>
                                    )
                                  })}
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          }
          right={
            <div className="h-full p-4 overflow-auto">
              {selection.type === 'none' && (
                <GlobalActivityFeed
                  trials={metrics?.trials || []}
                  onTrialSelect={(trial) => setSelection({ type: 'trial', trial })}
                  onJobSelect={(jobName) => {
                    toggleJob(jobName)
                    setSelection({ type: 'job', jobName })
                  }}
                />
              )}

              {selection.type === 'job' && (
                <JobTabbedPanel
                  jobName={selection.jobName}
                  models={filteredHierarchy.get(selection.jobName) || new Map()}
                  jobSummary={jobSummaryMap.get(selection.jobName)}
                  allTrials={metrics?.trials || []}
                  onFilesSelect={(trialPath) => setFilesModalPath(trialPath)}
                />
              )}

              {selection.type === 'model' && (
                <ModelOverviewPanel modelRun={selection.modelRun} />
              )}

              {selection.type === 'trial' && (
                <TrialDetailPanel
                  trial={selection.trial}
                  onClose={() => setSelection({ type: 'none' })}
                />
              )}

              {(selection.type === 'system-info' || selection.type === 'containers' || selection.type === 'stale-trials') && (
                <SystemInfoPanel
                  type={selection.type}
                  onClose={() => setSelection({ type: 'none' })}
                  onRefresh={refetch}
                  onFilesSelect={(trialPath) => setFilesModalPath(trialPath)}
                  initialContainerTab={selection.type === 'containers' ? selection.initialTab : undefined}
                />
              )}

              {selection.type === 'job-activity' && (
                <JobActivityPanel
                  jobName={selection.jobName}
                  agent={selection.agent}
                  model={selection.model}
                  onClose={() => setSelection({ type: 'none' })}
                  onTrialSelect={(trialPath) => {
                    // Find the trial in metrics and select it
                    const trial = metrics?.trials.find(t => t.trialPath === trialPath)
                    if (trial) {
                      setSelection({ type: 'trial', trial })
                    }
                  }}
                  onFilesSelect={(trialPath) => {
                    // Use separate modal state so it doesn't affect current selection
                    setFilesModalPath(trialPath)
                  }}
                />
              )}

              {selection.type === 'harbor-jobs' && (
                <HarborJobsPanel
                  onClose={() => setSelection({ type: 'none' })}
                />
              )}

              {selection.type === 'timeline' && metrics && (
                <CompletionTimelineChart
                  trials={metrics.trials}
                  jobs={metrics.jobs}
                  onClose={() => setSelection({ type: 'none' })}
                />
              )}
            </div>
          }
        />
      </div>

      {/* File browser modal - rendered at root level with separate state */}
      {filesModalPath && (
        <TrialFilesPanel
          trialPath={filesModalPath}
          onClose={() => setFilesModalPath(null)}
        />
      )}
    </div>
  )
}

// Model Overview Panel
function ModelOverviewPanel({ modelRun }: { modelRun: ModelRunStats }) {
  // Group trials by task and show results
  const taskResults = new Map<string, ProcessedTrial[]>()
  for (const trial of modelRun.trials) {
    if (!taskResults.has(trial.taskName)) {
      taskResults.set(trial.taskName, [])
    }
    taskResults.get(trial.taskName)!.push(trial)
  }

  const sortedTasks = Array.from(taskResults.entries()).sort((a, b) => {
    // Sort by status: pass first, then fail, then error
    const aStatus = a[1][0].status
    const bStatus = b[1][0].status
    const order = { pass: 0, fail: 1, error: 2, timeout: 3 }
    return (order[aStatus] ?? 4) - (order[bStatus] ?? 4)
  })

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <Bot className="w-5 h-5 text-muted-foreground" />
          <h2 className="text-xl font-semibold">{modelRun.agent}</h2>
        </div>
        <p className="text-sm text-muted-foreground">{modelRun.model}</p>
        <p className="text-xs text-muted-foreground mt-1">Job: {modelRun.jobName}</p>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-4 gap-4">
        <div className="bg-card border border-border rounded-lg p-4 text-center">
          <div className="text-2xl font-bold">{modelRun.trials.length}</div>
          <div className="text-xs text-muted-foreground">Tasks</div>
        </div>
        <div className="bg-card border border-border rounded-lg p-4 text-center">
          <div className={`text-2xl font-bold ${modelRun.passRate >= 0.5 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
            {formatPercent(modelRun.passRate)}
          </div>
          <div className="text-xs text-muted-foreground">Pass Rate</div>
        </div>
        <div className="bg-card border border-border rounded-lg p-4 text-center">
          <div className="text-2xl font-bold">{formatCost(modelRun.totalCost)}</div>
          <div className="text-xs text-muted-foreground">Total Cost</div>
        </div>
        <div className="bg-card border border-border rounded-lg p-4 text-center">
          <div className="text-2xl font-bold">{isNaN(modelRun.avgDuration) ? '-' : formatDuration(modelRun.avgDuration)}</div>
          <div className="text-xs text-muted-foreground">Avg Duration</div>
        </div>
      </div>

      {/* Pass/Fail breakdown */}
      <div className="flex items-center gap-4">
        <div className="flex-1 h-3 bg-muted rounded-full overflow-hidden flex">
          <div
            className="bg-green-500 h-full"
            style={{ width: `${modelRun.trials.length > 0 ? (modelRun.passedCount / modelRun.trials.length) * 100 : 0}%` }}
          />
          <div
            className="bg-red-500 h-full"
            style={{ width: `${modelRun.trials.length > 0 ? (modelRun.failedCount / modelRun.trials.length) * 100 : 0}%` }}
          />
          <div
            className="bg-orange-500 h-full"
            style={{ width: `${modelRun.trials.length > 0 ? (modelRun.errorCount / modelRun.trials.length) * 100 : 0}%` }}
          />
        </div>
        <div className="text-sm space-x-3">
          <span className="text-green-600 dark:text-green-400">{modelRun.passedCount} pass</span>
          <span className="text-red-600 dark:text-red-400">{modelRun.failedCount} fail</span>
          <span className="text-orange-600 dark:text-orange-400">{modelRun.errorCount} error</span>
        </div>
      </div>

      {/* Task results table */}
      <div>
        <h3 className="text-sm font-medium mb-3">Task Results</h3>
        <div className="border border-border rounded-lg overflow-hidden max-h-[400px] overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 sticky top-0">
              <tr>
                <th className="text-left px-4 py-2 font-medium">Task</th>
                <th className="text-center px-4 py-2 font-medium">Status</th>
                <th className="text-right px-4 py-2 font-medium">Reward</th>
                <th className="text-right px-4 py-2 font-medium">Duration</th>
                <th className="text-right px-4 py-2 font-medium">Cost</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {sortedTasks.map(([taskName, trials]) => {
                const trial = trials[0]
                return (
                  <tr key={taskName} className="hover:bg-muted/30">
                    <td className="px-4 py-2 truncate max-w-[200px]" title={taskName}>{taskName}</td>
                    <td className="text-center px-4 py-2">
                      <span className={`badge-${trial.status} px-2 py-0.5 text-xs rounded`}>
                        {trial.status}
                      </span>
                    </td>
                    <td className="text-right px-4 py-2">
                      {trial.reward !== null ? trial.reward.toFixed(2) : '-'}
                    </td>
                    <td className="text-right px-4 py-2 text-muted-foreground">
                      {formatDuration(trial.durationMs)}
                    </td>
                    <td className="text-right px-4 py-2 text-muted-foreground">
                      {formatCost(trial.costUsd)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

// Global Activity Feed - shows latest trials across all jobs
function GlobalActivityFeed({
  trials,
  onTrialSelect,
  onJobSelect,
}: {
  trials: ProcessedTrial[]
  onTrialSelect: (trial: ProcessedTrial) => void
  onJobSelect: (jobName: string) => void
}) {
  const [feedFilter, setFeedFilter] = useState<'all' | 'pass' | 'fail' | 'error'>('all')

  // Parse date helper
  const parseDate = (dateStr: string): number => {
    if (dateStr.includes('T') && !dateStr.includes('Z') && !dateStr.match(/[+-]\d{2}:\d{2}$/)) {
      return new Date(dateStr + 'Z').getTime()
    }
    return new Date(dateStr).getTime()
  }

  // Sort trials by finishedAt descending, take latest 200
  const recentTrials = useMemo(() => {
    return trials
      .filter(t => t.finishedAt)
      .sort((a, b) => parseDate(b.finishedAt) - parseDate(a.finishedAt))
      .slice(0, 200)
  }, [trials])

  const filteredTrials = useMemo(() => {
    if (feedFilter === 'all') return recentTrials
    return recentTrials.filter(t => t.status === feedFilter)
  }, [recentTrials, feedFilter])

  // Per-job summary of recent activity
  const jobActivity = useMemo(() => {
    const map = new Map<string, { total: number; passed: number; failed: number; errored: number; latest: string }>()
    for (const t of recentTrials) {
      const entry = map.get(t.jobName) || { total: 0, passed: 0, failed: 0, errored: 0, latest: t.finishedAt }
      entry.total++
      if (t.status === 'pass') entry.passed++
      else if (t.status === 'fail') entry.failed++
      else entry.errored++
      if (parseDate(t.finishedAt) > parseDate(entry.latest)) entry.latest = t.finishedAt
      map.set(t.jobName, entry)
    }
    return Array.from(map.entries()).sort((a, b) => parseDate(b[1].latest) - parseDate(a[1].latest))
  }, [recentTrials])

  const statusIcons: Record<string, JSX.Element> = {
    pass: <CheckCircle className="w-3.5 h-3.5 text-green-500" />,
    fail: <XCircle className="w-3.5 h-3.5 text-red-500" />,
    error: <AlertTriangle className="w-3.5 h-3.5 text-yellow-500" />,
    timeout: <Clock className="w-3.5 h-3.5 text-orange-500" />,
  }

  const formatTime = (isoString: string): string => {
    const dateStr = isoString.includes('Z') || isoString.includes('+') ? isoString : isoString + 'Z'
    const date = new Date(dateStr)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffMins = Math.floor(diffMs / 60000)
    if (diffMins < 1) return 'just now'
    if (diffMins < 60) return `${diffMins}m ago`
    const diffHours = Math.floor(diffMins / 60)
    if (diffHours < 24) return `${diffHours}h ago`
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' })
  }

  const counts = useMemo(() => ({
    all: recentTrials.length,
    pass: recentTrials.filter(t => t.status === 'pass').length,
    fail: recentTrials.filter(t => t.status === 'fail').length,
    error: recentTrials.filter(t => t.status === 'error' || t.status === 'timeout').length,
  }), [recentTrials])

  return (
    <div className="flex flex-col h-full gap-4">
      <div className="flex-shrink-0">
        <h2 className="text-xl font-semibold mb-1">Latest Activity</h2>
        <p className="text-sm text-muted-foreground">Recent trial completions across all jobs</p>
      </div>

      {/* Job summary cards */}
      <div className="flex-shrink-0 grid grid-cols-2 gap-3">
        {jobActivity.slice(0, 6).map(([jobName, stats]) => (
          <button
            key={jobName}
            onClick={() => onJobSelect(jobName)}
            className="p-3 bg-card border border-border rounded-lg text-left hover:bg-muted/50 transition-colors"
          >
            <div className="text-sm font-medium truncate">{jobName.replace('main-', '').replace(/-/g, ' ')}</div>
            <div className="flex items-center gap-3 mt-1 text-xs">
              <span className="text-green-500">{stats.passed} pass</span>
              <span className="text-red-500">{stats.failed} fail</span>
              {stats.errored > 0 && <span className="text-yellow-500">{stats.errored} err</span>}
              <span className="ml-auto text-muted-foreground">{formatTime(stats.latest)}</span>
            </div>
          </button>
        ))}
      </div>

      {/* Filter tabs */}
      <div className="flex-shrink-0 flex bg-muted rounded-md p-0.5">
        {(['all', 'pass', 'fail', 'error'] as const).map(f => (
          <button
            key={f}
            onClick={() => setFeedFilter(f)}
            className={`flex-1 px-2 py-1 text-xs rounded transition-colors ${
              feedFilter === f ? 'bg-background shadow' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {f === 'all' ? `All (${counts.all})` :
             f === 'pass' ? `Pass (${counts.pass})` :
             f === 'fail' ? `Fail (${counts.fail})` :
             `Error (${counts.error})`}
          </button>
        ))}
      </div>

      {/* Trial feed */}
      <div className="flex-1 min-h-0 overflow-auto space-y-1.5">
        {filteredTrials.map((trial, i) => (
          <button
            key={`${trial.id}-${i}`}
            onClick={() => onTrialSelect(trial)}
            className="w-full p-2.5 bg-muted/30 hover:bg-muted/50 rounded-lg text-sm text-left transition-colors flex items-start gap-2"
          >
            <div className="mt-0.5 flex-shrink-0">{statusIcons[trial.status] || statusIcons.error}</div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-medium truncate">{trial.taskName}</span>
                <span className={`ml-auto text-xs font-medium flex-shrink-0 ${
                  trial.status === 'pass' ? 'text-green-500' :
                  trial.status === 'fail' ? 'text-red-500' : 'text-yellow-500'
                }`}>
                  {trial.status.toUpperCase()}
                </span>
              </div>
              <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-2">
                <span className="truncate">{trial.jobName.replace('main-', '')}</span>
                <span>·</span>
                <span>{trial.agent}</span>
                <span>·</span>
                <span className="flex-shrink-0">{formatTime(trial.finishedAt)}</span>
              </div>
            </div>
          </button>
        ))}
        {filteredTrials.length === 0 && (
          <div className="text-sm text-muted-foreground py-8 text-center">
            No trials matching filter
          </div>
        )}
      </div>
    </div>
  )
}

export default App

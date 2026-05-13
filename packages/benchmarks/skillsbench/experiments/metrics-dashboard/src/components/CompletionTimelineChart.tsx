import { useMemo, useState } from 'react'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  BarChart,
  Bar
} from 'recharts'
import { TrendingUp, Clock, BarChart2, X } from 'lucide-react'
import type { ProcessedTrial, JobSummary } from '../types/metrics'

interface CompletionTimelineChartProps {
  trials: ProcessedTrial[]
  jobs?: JobSummary[]
  onClose?: () => void
}

type TimeRange = '1h' | '6h' | '24h' | '7d' | 'all'
type ChartMode = 'cumulative' | 'throughput'

export function CompletionTimelineChart({ trials, onClose }: CompletionTimelineChartProps) {
  const [timeRange, setTimeRange] = useState<TimeRange>('24h')
  const [chartMode, setChartMode] = useState<ChartMode>('cumulative')
  const [selectedJobs, setSelectedJobs] = useState<Set<string>>(new Set())

  // Get unique job names
  const jobNames = useMemo(() => {
    return [...new Set(trials.map(t => t.jobName))].sort()
  }, [trials])

  // Helper to parse dates - timestamps from server are UTC but without 'Z'
  const parseDate = (dateStr: string): number => {
    if (dateStr.includes('T') && !dateStr.includes('Z') && !dateStr.match(/[+-]\d{2}:\d{2}$/)) {
      return new Date(dateStr + 'Z').getTime()
    }
    return new Date(dateStr).getTime()
  }

  // Filter trials by time range and selected jobs
  const filteredTrials = useMemo(() => {
    const now = Date.now()
    const ranges: Record<TimeRange, number> = {
      '1h': 60 * 60 * 1000,
      '6h': 6 * 60 * 60 * 1000,
      '24h': 24 * 60 * 60 * 1000,
      '7d': 7 * 24 * 60 * 60 * 1000,
      'all': Infinity
    }
    const cutoff = now - ranges[timeRange]

    return trials.filter(t => {
      if (!t.finishedAt) return false
      const finishedTime = parseDate(t.finishedAt)
      if (finishedTime < cutoff) return false
      if (selectedJobs.size > 0 && !selectedJobs.has(t.jobName)) return false
      return true
    }).sort((a, b) => parseDate(a.finishedAt!) - parseDate(b.finishedAt!))
  }, [trials, timeRange, selectedJobs])

  // Generate cumulative timeline data
  const cumulativeData = useMemo(() => {
    if (filteredTrials.length === 0) return []

    const dataPoints: Array<{
      time: number
      timeLabel: string
      total: number
      passed: number
      failed: number
      [key: string]: number | string
    }> = []

    // Group by time buckets based on range
    const bucketSize = timeRange === '1h' ? 5 * 60 * 1000 : // 5 min buckets
                       timeRange === '6h' ? 15 * 60 * 1000 : // 15 min buckets
                       timeRange === '24h' ? 60 * 60 * 1000 : // 1 hour buckets
                       timeRange === '7d' ? 6 * 60 * 60 * 1000 : // 6 hour buckets
                       24 * 60 * 60 * 1000 // 1 day buckets

    const startTime = parseDate(filteredTrials[0].finishedAt!)
    const endTime = Date.now()

    let cumTotal = 0
    let cumPassed = 0
    let cumFailed = 0
    const jobCounts: Record<string, number> = {}

    let trialIdx = 0
    for (let t = startTime; t <= endTime; t += bucketSize) {
      // Count trials in this bucket
      while (trialIdx < filteredTrials.length) {
        const trial = filteredTrials[trialIdx]
        const trialTime = parseDate(trial.finishedAt!)
        if (trialTime > t + bucketSize) break

        cumTotal++
        if ((trial.reward ?? 0) >= 1) cumPassed++
        else cumFailed++

        if (!jobCounts[trial.jobName]) jobCounts[trial.jobName] = 0
        jobCounts[trial.jobName]++

        trialIdx++
      }

      const date = new Date(t)
      const timeLabel = timeRange === '1h' || timeRange === '6h'
        ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : timeRange === '24h'
        ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : date.toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit' })

      const point: any = {
        time: t,
        timeLabel,
        total: cumTotal,
        passed: cumPassed,
        failed: cumFailed,
      }

      // Add per-job counts
      for (const job of jobNames) {
        point[job] = jobCounts[job] || 0
      }

      dataPoints.push(point)
    }

    return dataPoints
  }, [filteredTrials, timeRange, jobNames])

  // Generate throughput data (completions per time bucket)
  const throughputData = useMemo(() => {
    if (filteredTrials.length === 0) return []

    const bucketSize = timeRange === '1h' ? 5 * 60 * 1000 :
                       timeRange === '6h' ? 15 * 60 * 1000 :
                       timeRange === '24h' ? 60 * 60 * 1000 :
                       timeRange === '7d' ? 6 * 60 * 60 * 1000 :
                       24 * 60 * 60 * 1000

    const buckets = new Map<number, { total: number; passed: number; failed: number }>()

    for (const trial of filteredTrials) {
      const time = parseDate(trial.finishedAt!)
      const bucket = Math.floor(time / bucketSize) * bucketSize

      if (!buckets.has(bucket)) {
        buckets.set(bucket, { total: 0, passed: 0, failed: 0 })
      }
      const b = buckets.get(bucket)!
      b.total++
      if ((trial.reward ?? 0) >= 1) b.passed++
      else b.failed++
    }

    return Array.from(buckets.entries())
      .sort(([a], [b]) => a - b)
      .map(([time, counts]) => {
        const date = new Date(time)
        const timeLabel = timeRange === '1h' || timeRange === '6h'
          ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          : timeRange === '24h'
          ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          : date.toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit' })

        return {
          time,
          timeLabel,
          ...counts
        }
      })
  }, [filteredTrials, timeRange])

  const toggleJob = (jobName: string) => {
    setSelectedJobs(prev => {
      const next = new Set(prev)
      if (next.has(jobName)) next.delete(jobName)
      else next.add(jobName)
      return next
    })
  }

  const chartData = chartMode === 'cumulative' ? cumulativeData : throughputData

  // Job colors
  const colors = ['#22c55e', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316']
  const getJobColor = (idx: number) => colors[idx % colors.length]

  return (
    <div className="border border-border rounded-lg bg-card overflow-hidden flex flex-col h-[calc(100vh-8rem)]">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border flex items-center justify-between bg-muted/30 shrink-0">
        <div className="flex items-center gap-2">
          <TrendingUp className="w-5 h-5" />
          <span className="font-medium">Completion Timeline</span>
          <span className="text-xs text-muted-foreground">({filteredTrials.length} trials)</span>
        </div>
        <div className="flex items-center gap-2">
          {/* Chart mode toggle */}
          <div className="flex bg-muted rounded-md p-0.5">
            <button
              onClick={() => setChartMode('cumulative')}
              className={`px-2 py-1 text-xs rounded ${chartMode === 'cumulative' ? 'bg-background shadow' : ''}`}
            >
              <TrendingUp className="w-3 h-3 inline mr-1" />
              Cumulative
            </button>
            <button
              onClick={() => setChartMode('throughput')}
              className={`px-2 py-1 text-xs rounded ${chartMode === 'throughput' ? 'bg-background shadow' : ''}`}
            >
              <BarChart2 className="w-3 h-3 inline mr-1" />
              Throughput
            </button>
          </div>

          {/* Time range selector */}
          <div className="flex bg-muted rounded-md p-0.5">
            {(['1h', '6h', '24h', '7d', 'all'] as TimeRange[]).map(range => (
              <button
                key={range}
                onClick={() => setTimeRange(range)}
                className={`px-2 py-1 text-xs rounded ${timeRange === range ? 'bg-background shadow' : ''}`}
              >
                {range}
              </button>
            ))}
          </div>

          {onClose && (
            <button onClick={onClose} className="p-1.5 hover:bg-muted rounded">
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* Job filter chips */}
      {jobNames.length > 1 && (
        <div className="px-4 py-2 border-b border-border flex flex-wrap gap-1.5">
          <span className="text-xs text-muted-foreground mr-1">Filter:</span>
          {jobNames.map((job, idx) => (
            <button
              key={job}
              onClick={() => toggleJob(job)}
              className={`px-2 py-0.5 text-xs rounded-full border transition-colors ${
                selectedJobs.size === 0 || selectedJobs.has(job)
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border text-muted-foreground hover:border-primary/50'
              }`}
              style={{
                borderColor: selectedJobs.size === 0 || selectedJobs.has(job) ? getJobColor(idx) : undefined,
                backgroundColor: selectedJobs.size === 0 || selectedJobs.has(job) ? `${getJobColor(idx)}20` : undefined,
                color: selectedJobs.size === 0 || selectedJobs.has(job) ? getJobColor(idx) : undefined
              }}
            >
              {job.replace(/-/g, ' ').slice(0, 25)}
            </button>
          ))}
          {selectedJobs.size > 0 && (
            <button
              onClick={() => setSelectedJobs(new Set())}
              className="px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground"
            >
              Clear
            </button>
          )}
        </div>
      )}

      {/* Chart */}
      <div className="flex-1 p-4">
        {chartData.length === 0 ? (
          <div className="h-full flex items-center justify-center text-muted-foreground">
            <div className="text-center">
              <Clock className="w-8 h-8 mx-auto mb-2 opacity-50" />
              <div>No completed trials in this time range</div>
            </div>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            {chartMode === 'cumulative' ? (
              <LineChart data={chartData} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis
                  dataKey="timeLabel"
                  tick={{ fontSize: 11 }}
                  className="text-muted-foreground"
                />
                <YAxis tick={{ fontSize: 11 }} className="text-muted-foreground" />
                <Tooltip
                  contentStyle={{
                    backgroundColor: 'hsl(var(--card))',
                    border: '1px solid hsl(var(--border))',
                    borderRadius: '6px',
                    fontSize: '12px'
                  }}
                />
                <Legend />
                <Line
                  type="monotone"
                  dataKey="total"
                  stroke="#3b82f6"
                  strokeWidth={2}
                  dot={false}
                  name="Total"
                />
                <Line
                  type="monotone"
                  dataKey="passed"
                  stroke="#22c55e"
                  strokeWidth={2}
                  dot={false}
                  name="Passed"
                />
                <Line
                  type="monotone"
                  dataKey="failed"
                  stroke="#ef4444"
                  strokeWidth={2}
                  dot={false}
                  name="Failed"
                />
              </LineChart>
            ) : (
              <BarChart data={chartData} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis
                  dataKey="timeLabel"
                  tick={{ fontSize: 11 }}
                  className="text-muted-foreground"
                />
                <YAxis tick={{ fontSize: 11 }} className="text-muted-foreground" />
                <Tooltip
                  contentStyle={{
                    backgroundColor: 'hsl(var(--card))',
                    border: '1px solid hsl(var(--border))',
                    borderRadius: '6px',
                    fontSize: '12px'
                  }}
                />
                <Legend />
                <Bar dataKey="passed" stackId="a" fill="#22c55e" name="Passed" />
                <Bar dataKey="failed" stackId="a" fill="#ef4444" name="Failed" />
              </BarChart>
            )}
          </ResponsiveContainer>
        )}
      </div>

      {/* Summary stats */}
      <div className="px-4 py-2 border-t border-border bg-muted/20 flex items-center gap-6 text-xs">
        <div>
          <span className="text-muted-foreground">Total: </span>
          <span className="font-medium">{filteredTrials.length}</span>
        </div>
        <div>
          <span className="text-muted-foreground">Passed: </span>
          <span className="font-medium text-green-500">
            {filteredTrials.filter(t => (t.reward ?? 0) >= 1).length}
          </span>
        </div>
        <div>
          <span className="text-muted-foreground">Failed: </span>
          <span className="font-medium text-red-500">
            {filteredTrials.filter(t => (t.reward ?? 0) < 1).length}
          </span>
        </div>
        <div>
          <span className="text-muted-foreground">Pass Rate: </span>
          <span className="font-medium">
            {filteredTrials.length > 0
              ? ((filteredTrials.filter(t => (t.reward ?? 0) >= 1).length / filteredTrials.length) * 100).toFixed(1)
              : 0}%
          </span>
        </div>
      </div>
    </div>
  )
}

import type { ProcessedTrial, JobSummary } from '../types/metrics'
import { formatCost, formatPercent } from '../utils/formatters'
import { Card, CardContent } from '@/components/ui/card'

interface SummaryCardsProps {
  trials: ProcessedTrial[]
  jobs: JobSummary[]
}

export function SummaryCards({ trials, jobs }: SummaryCardsProps) {
  const totalTrials = trials.length
  const passedTrials = trials.filter((t) => t.status === 'pass').length
  const failedTrials = trials.filter((t) => t.status === 'fail').length
  const erroredTrials = trials.filter((t) => t.status === 'error' || t.status === 'timeout').length
  const passRate = totalTrials > 0 ? passedTrials / totalTrials : 0
  const totalCost = trials.reduce((sum, t) => sum + (t.costUsd ?? 0), 0)

  const uniqueTasks = new Set(trials.map((t) => t.taskName)).size
  const uniqueModels = new Set(trials.map((t) => t.model)).size

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-6">
      <Card>
        <CardContent className="p-4">
          <div className="text-2xl font-bold">{jobs.length}</div>
          <div className="text-sm text-muted-foreground">Jobs</div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4">
          <div className="text-2xl font-bold">{totalTrials}</div>
          <div className="text-sm text-muted-foreground">Trials</div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4">
          <div className={`text-2xl font-bold ${passRate >= 0.5 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
            {formatPercent(passRate)}
          </div>
          <div className="text-sm text-muted-foreground">Pass Rate</div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4">
          <div className="flex items-baseline gap-2">
            <span className="text-lg font-semibold text-green-600 dark:text-green-400">{passedTrials}</span>
            <span className="text-muted-foreground">/</span>
            <span className="text-lg font-semibold text-red-600 dark:text-red-400">{failedTrials}</span>
            <span className="text-muted-foreground">/</span>
            <span className="text-lg font-semibold text-orange-600 dark:text-orange-400">{erroredTrials}</span>
          </div>
          <div className="text-sm text-muted-foreground">Pass / Fail / Error</div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4">
          <div className="text-2xl font-bold">{formatCost(totalCost)}</div>
          <div className="text-sm text-muted-foreground">Total Cost</div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4">
          <div className="flex items-baseline gap-2">
            <span className="text-lg font-semibold">{uniqueTasks}</span>
            <span className="text-muted-foreground text-sm">tasks</span>
            <span className="text-lg font-semibold">{uniqueModels}</span>
            <span className="text-muted-foreground text-sm">models</span>
          </div>
          <div className="text-sm text-muted-foreground">Coverage</div>
        </CardContent>
      </Card>
    </div>
  )
}

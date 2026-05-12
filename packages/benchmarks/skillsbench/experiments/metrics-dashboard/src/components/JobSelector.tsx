import type { JobSummary } from '../types/metrics'
import { formatPercent } from '../utils/formatters'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

interface JobSelectorProps {
  jobs: JobSummary[]
  selectedJob: string | null
  onJobChange: (jobName: string | null) => void
}

export function JobSelector({ jobs, selectedJob, onJobChange }: JobSelectorProps) {
  const totalTrials = jobs.reduce((sum, j) => sum + j.completedTrials, 0)

  return (
    <div className="mb-6">
      <label className="block text-xs text-muted-foreground uppercase tracking-wide mb-2">
        Job
      </label>
      <Select
        value={selectedJob ?? 'all'}
        onValueChange={(value) => onJobChange(value === 'all' ? null : value)}
      >
        <SelectTrigger className="w-full max-w-md">
          <SelectValue placeholder="Select a job" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">
            All Jobs ({totalTrials} trials)
          </SelectItem>
          {jobs.map((job) => (
            <SelectItem key={job.jobName} value={job.jobName}>
              {job.jobName} - {job.completedTrials}/{job.expectedTrials} trials ({job.jobStatus === 'running' ? 'running' : formatPercent(job.passRate)})
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

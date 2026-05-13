import { useState, useMemo } from 'react'
import type { ProcessedTrial } from '../types/metrics'
import { formatCost, formatPercent } from '../utils/formatters'
import { ChevronRight, ChevronDown } from 'lucide-react'

interface JobsTableProps {
  trials: ProcessedTrial[]
  onTrialSelect: (trial: ProcessedTrial) => void
}

interface JobGroup {
  jobName: string
  trials: ProcessedTrial[]
  totalTrials: number
  passed: number
  failed: number
  errored: number
  passRate: number
  totalCost: number
  models: string[]
  agents: string[]
}

export function JobsTable({ trials, onTrialSelect }: JobsTableProps) {
  const [expandedJobs, setExpandedJobs] = useState<Set<string>>(new Set())

  const jobGroups = useMemo(() => {
    const groups = new Map<string, ProcessedTrial[]>()

    for (const trial of trials) {
      if (!groups.has(trial.jobName)) {
        groups.set(trial.jobName, [])
      }
      groups.get(trial.jobName)!.push(trial)
    }

    return Array.from(groups.entries()).map(([jobName, jobTrials]): JobGroup => {
      const passed = jobTrials.filter(t => t.status === 'pass').length
      const failed = jobTrials.filter(t => t.status === 'fail').length
      const errored = jobTrials.filter(t => t.status === 'error' || t.status === 'timeout').length
      const totalCost = jobTrials.reduce((sum, t) => sum + (t.costUsd ?? 0), 0)
      const models = [...new Set(jobTrials.map(t => t.model))]
      const agents = [...new Set(jobTrials.map(t => t.agent))]

      return {
        jobName,
        trials: jobTrials,
        totalTrials: jobTrials.length,
        passed,
        failed,
        errored,
        passRate: jobTrials.length > 0 ? passed / jobTrials.length : 0,
        totalCost,
        models,
        agents,
      }
    }).sort((a, b) => b.totalTrials - a.totalTrials)
  }, [trials])

  const toggleJob = (jobName: string) => {
    setExpandedJobs(prev => {
      const next = new Set(prev)
      if (next.has(jobName)) {
        next.delete(jobName)
      } else {
        next.add(jobName)
      }
      return next
    })
  }

  return (
    <div className="border border-border rounded-lg overflow-hidden bg-card">
      <table className="w-full">
        <thead className="bg-muted/50">
          <tr>
            <th className="table-header w-8"></th>
            <th className="table-header">Job Name</th>
            <th className="table-header text-center">Trials</th>
            <th className="table-header text-center">Pass Rate</th>
            <th className="table-header text-center">Pass/Fail/Error</th>
            <th className="table-header text-right">Cost</th>
            <th className="table-header">Models</th>
            <th className="table-header">Agents</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {jobGroups.map((job) => (
            <>
              <tr
                key={job.jobName}
                className="hover:bg-muted/30 cursor-pointer"
                onClick={() => toggleJob(job.jobName)}
              >
                <td className="table-cell">
                  {expandedJobs.has(job.jobName) ? (
                    <ChevronDown className="w-4 h-4 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="w-4 h-4 text-muted-foreground" />
                  )}
                </td>
                <td className="table-cell font-medium">{job.jobName}</td>
                <td className="table-cell text-center">{job.totalTrials}</td>
                <td className="table-cell text-center">
                  <span className={job.passRate >= 0.5 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}>
                    {formatPercent(job.passRate)}
                  </span>
                </td>
                <td className="table-cell text-center">
                  <span className="text-green-600 dark:text-green-400">{job.passed}</span>
                  <span className="text-muted-foreground mx-1">/</span>
                  <span className="text-red-600 dark:text-red-400">{job.failed}</span>
                  <span className="text-muted-foreground mx-1">/</span>
                  <span className="text-orange-600 dark:text-orange-400">{job.errored}</span>
                </td>
                <td className="table-cell text-right text-muted-foreground">
                  {formatCost(job.totalCost)}
                </td>
                <td className="table-cell">
                  <div className="flex flex-wrap gap-1">
                    {job.models.slice(0, 3).map(model => (
                      <span key={model} className="text-xs bg-muted px-1.5 py-0.5 rounded">
                        {model.split('@')[0]}
                      </span>
                    ))}
                    {job.models.length > 3 && (
                      <span className="text-xs text-muted-foreground">+{job.models.length - 3}</span>
                    )}
                  </div>
                </td>
                <td className="table-cell">
                  <div className="flex flex-wrap gap-1">
                    {job.agents.map(agent => (
                      <span key={agent} className="text-xs bg-muted px-1.5 py-0.5 rounded">
                        {agent}
                      </span>
                    ))}
                  </div>
                </td>
              </tr>

              {/* Expanded trials */}
              {expandedJobs.has(job.jobName) && (
                <tr key={`${job.jobName}-expanded`}>
                  <td colSpan={8} className="p-0">
                    <div className="bg-muted/20 border-t border-border">
                      <table className="w-full">
                        <thead>
                          <tr className="text-xs text-muted-foreground">
                            <th className="px-4 py-2 text-left pl-12">Task</th>
                            <th className="px-4 py-2 text-left">Agent</th>
                            <th className="px-4 py-2 text-left">Model</th>
                            <th className="px-4 py-2 text-center">Status</th>
                            <th className="px-4 py-2 text-center">Reward</th>
                            <th className="px-4 py-2 text-right">Cost</th>
                            <th className="px-4 py-2 text-left">Error</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border/50">
                          {job.trials.map(trial => (
                            <tr
                              key={trial.id}
                              className="hover:bg-muted/30 cursor-pointer text-sm"
                              onClick={(e) => {
                                e.stopPropagation()
                                onTrialSelect(trial)
                              }}
                            >
                              <td className="px-4 py-2 pl-12">{trial.taskName}</td>
                              <td className="px-4 py-2 text-muted-foreground">{trial.agent}</td>
                              <td className="px-4 py-2 text-muted-foreground text-xs">{trial.model.split('@')[0]}</td>
                              <td className="px-4 py-2 text-center">
                                <span className={`badge badge-${trial.status}`}>{trial.status}</span>
                              </td>
                              <td className="px-4 py-2 text-center">
                                {trial.reward !== null ? (
                                  <span className={trial.reward >= 1 ? 'text-green-600 dark:text-green-400' : ''}>
                                    {trial.reward.toFixed(2)}
                                  </span>
                                ) : '-'}
                              </td>
                              <td className="px-4 py-2 text-right text-muted-foreground">
                                {formatCost(trial.costUsd)}
                              </td>
                              <td className="px-4 py-2">
                                {trial.exceptionInfo && (
                                  <span className="badge badge-error text-xs">
                                    {trial.exceptionInfo.exception_type}
                                  </span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </td>
                </tr>
              )}
            </>
          ))}
        </tbody>
      </table>

      {jobGroups.length === 0 && (
        <div className="p-8 text-center text-muted-foreground">
          No jobs match the current filters
        </div>
      )}
    </div>
  )
}

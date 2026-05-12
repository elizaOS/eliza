import { useState, useEffect } from 'react'
import type { ProcessedTrial, Trajectory, TrajectoryStep } from '../types/metrics'
import { formatCost, formatDuration } from '../utils/formatters'
import { X, ChevronRight, ChevronDown, Clock, DollarSign, MessageSquare, Terminal, AlertCircle, CheckCircle, Loader2, FolderOpen } from 'lucide-react'
import { FileBrowser } from './FileBrowser'

interface TrialDetailPanelProps {
  trial: ProcessedTrial
  onClose: () => void
}

export function TrialDetailPanel({ trial, onClose }: TrialDetailPanelProps) {
  const [trajectory, setTrajectory] = useState<Trajectory | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expandedSteps, setExpandedSteps] = useState<Set<number>>(new Set())
  const [activeTab, setActiveTab] = useState<'overview' | 'trajectory' | 'files' | 'error'>('overview')

  useEffect(() => {
    if (trial.trialPath) {
      setLoading(true)
      setError(null)
      fetch(`/api/trajectory?path=${encodeURIComponent(trial.trialPath)}`)
        .then(res => {
          if (!res.ok) throw new Error('Failed to load trajectory')
          return res.json()
        })
        .then(data => {
          setTrajectory(data)
          setLoading(false)
        })
        .catch(err => {
          setError(err.message)
          setLoading(false)
        })
    }
  }, [trial.trialPath])

  const toggleStep = (stepId: number) => {
    setExpandedSteps(prev => {
      const next = new Set(prev)
      if (next.has(stepId)) next.delete(stepId)
      else next.add(stepId)
      return next
    })
  }

  const statusColors = {
    pass: 'bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-200',
    fail: 'bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-200',
    error: 'bg-orange-100 text-orange-800 dark:bg-orange-900/50 dark:text-orange-200',
    timeout: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/50 dark:text-yellow-200',
  }

  return (
    <div className="border border-border rounded-lg bg-card overflow-hidden flex flex-col h-[calc(100vh-8rem)]">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border flex items-center justify-between bg-muted/30 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`${statusColors[trial.status]} px-2 py-0.5 text-xs rounded shrink-0`}>
            {trial.status}
          </span>
          <span className="font-medium text-sm truncate">{trial.taskName}</span>
        </div>
        <button onClick={onClose} className="p-1 hover:bg-muted rounded shrink-0">
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-border shrink-0">
        <button
          onClick={() => setActiveTab('overview')}
          className={`px-4 py-2 text-sm font-medium transition-colors ${
            activeTab === 'overview'
              ? 'border-b-2 border-primary text-primary'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          Overview
        </button>
        <button
          onClick={() => setActiveTab('trajectory')}
          className={`px-4 py-2 text-sm font-medium transition-colors ${
            activeTab === 'trajectory'
              ? 'border-b-2 border-primary text-primary'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          Trajectory {trajectory?.steps && `(${trajectory.steps.length})`}
        </button>
        <button
          onClick={() => setActiveTab('files')}
          className={`px-4 py-2 text-sm font-medium transition-colors flex items-center gap-1 ${
            activeTab === 'files'
              ? 'border-b-2 border-primary text-primary'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          <FolderOpen className="w-3 h-3" />
          Files
        </button>
        {trial.exceptionInfo && (
          <button
            onClick={() => setActiveTab('error')}
            className={`px-4 py-2 text-sm font-medium transition-colors ${
              activeTab === 'error'
                ? 'border-b-2 border-primary text-primary'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            Error
          </button>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {activeTab === 'overview' && (
          <div className="p-4 space-y-4">
            {/* Basic Info */}
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">Task:</span>
                  <span className="font-medium">{trial.taskName}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">Agent:</span>
                  <span>{trial.agent}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">Model:</span>
                  <span className="text-xs">{trial.model}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">Job:</span>
                  <span className="text-xs">{trial.jobName}</span>
                </div>
              </div>
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">Reward:</span>
                  <span className={trial.reward !== null && trial.reward >= 1 ? 'text-green-600 dark:text-green-400 font-medium' : ''}>
                    {trial.reward?.toFixed(2) ?? '-'}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <Clock className="w-3 h-3 text-muted-foreground" />
                  <span>{formatDuration(trial.durationMs)}</span>
                </div>
                <div className="flex items-center gap-2">
                  <DollarSign className="w-3 h-3 text-muted-foreground" />
                  <span>{formatCost(trial.costUsd)}</span>
                </div>
                {trial.nEpisodes && (
                  <div className="flex items-center gap-2">
                    <MessageSquare className="w-3 h-3 text-muted-foreground" />
                    <span>{trial.nEpisodes} episodes</span>
                  </div>
                )}
              </div>
            </div>

            {/* Token Usage */}
            <div className="border-t border-border pt-3">
              <h4 className="text-xs font-medium text-muted-foreground mb-2">Token Usage</h4>
              <div className="flex gap-4 text-sm">
                <div>
                  <span className="text-muted-foreground">Input:</span>{' '}
                  <span>{trial.inputTokens?.toLocaleString() ?? '-'}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Output:</span>{' '}
                  <span>{trial.outputTokens?.toLocaleString() ?? '-'}</span>
                </div>
                {trial.cacheTokens && (
                  <div>
                    <span className="text-muted-foreground">Cache:</span>{' '}
                    <span>{trial.cacheTokens.toLocaleString()}</span>
                  </div>
                )}
              </div>
            </div>

            {/* Trial Path */}
            <div className="border-t border-border pt-3">
              <h4 className="text-xs font-medium text-muted-foreground mb-2">Trial Path</h4>
              <code className="text-xs bg-muted px-2 py-1 rounded block overflow-x-auto">
                {trial.trialPath}
              </code>
            </div>
          </div>
        )}

        {activeTab === 'trajectory' && (
          <div className="p-2">
            {loading && (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
              </div>
            )}
            {error && (
              <div className="text-sm text-red-600 dark:text-red-400 p-4">
                {error}
              </div>
            )}
            {trajectory?.steps && (
              <div className="space-y-1">
                {trajectory.steps.map((step) => (
                  <TrajectoryStepView
                    key={step.step_id}
                    step={step}
                    isExpanded={expandedSteps.has(step.step_id)}
                    onToggle={() => toggleStep(step.step_id)}
                  />
                ))}
              </div>
            )}
            {!loading && !error && (!trajectory || !trajectory.steps) && (
              <div className="text-sm text-muted-foreground p-4">
                No trajectory data available
              </div>
            )}
          </div>
        )}

        {activeTab === 'files' && trial.trialPath && (
          <FileBrowser trialPath={trial.trialPath} />
        )}

        {activeTab === 'error' && trial.exceptionInfo && (
          <div className="p-4 space-y-3">
            <div className="flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-orange-600 dark:text-orange-400" />
              <span className="font-medium text-orange-600 dark:text-orange-400">
                {trial.exceptionInfo.exception_type}
              </span>
            </div>
            <p className="text-sm">{trial.exceptionInfo.exception_message}</p>
            <div className="border-t border-border pt-3">
              <h4 className="text-xs font-medium text-muted-foreground mb-2">Traceback</h4>
              <pre className="p-3 bg-muted rounded text-xs overflow-auto max-h-[400px] whitespace-pre-wrap font-mono">
                {trial.exceptionInfo.exception_traceback}
              </pre>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

interface TrajectoryStepViewProps {
  step: TrajectoryStep
  isExpanded: boolean
  onToggle: () => void
}

function TrajectoryStepView({ step, isExpanded, onToggle }: TrajectoryStepViewProps) {
  const sourceColors = {
    user: 'bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-200',
    agent: 'bg-purple-100 text-purple-800 dark:bg-purple-900/50 dark:text-purple-200',
    system: 'bg-gray-100 text-gray-800 dark:bg-gray-900/50 dark:text-gray-200',
  }

  // Truncate message for preview
  const preview = step.message.length > 200
    ? step.message.substring(0, 200) + '...'
    : step.message

  return (
    <div className="border border-border rounded-md overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full px-3 py-2 flex items-start gap-2 hover:bg-muted/50 transition-colors text-left"
      >
        {isExpanded ? (
          <ChevronDown className="w-4 h-4 mt-0.5 shrink-0" />
        ) : (
          <ChevronRight className="w-4 h-4 mt-0.5 shrink-0" />
        )}
        <span className={`${sourceColors[step.source]} px-1.5 py-0.5 text-xs rounded shrink-0`}>
          {step.source}
        </span>
        <span className="text-xs text-muted-foreground shrink-0">
          #{step.step_id}
        </span>
        {!isExpanded && (
          <span className="text-xs text-muted-foreground truncate">
            {preview}
          </span>
        )}
        {step.tool_calls && step.tool_calls.length > 0 && (
          <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground shrink-0">
            <Terminal className="w-3 h-3" />
            {step.tool_calls.length}
          </span>
        )}
        {step.metrics && (
          <span className="text-xs text-muted-foreground shrink-0">
            {formatCost(step.metrics.cost_usd)}
          </span>
        )}
      </button>

      {isExpanded && (
        <div className="border-t border-border">
          {/* Message */}
          <div className="p-3 bg-muted/20">
            <pre className="text-xs whitespace-pre-wrap font-mono overflow-x-auto max-h-64 overflow-y-auto">
              {step.message}
            </pre>
          </div>

          {/* Tool Calls */}
          {step.tool_calls && step.tool_calls.length > 0 && (
            <div className="border-t border-border p-3">
              <h5 className="text-xs font-medium text-muted-foreground mb-2 flex items-center gap-1">
                <Terminal className="w-3 h-3" />
                Tool Calls
              </h5>
              <div className="space-y-2">
                {step.tool_calls.map((call, idx) => (
                  <div key={idx} className="bg-muted rounded p-2">
                    <div className="text-xs font-medium text-purple-600 dark:text-purple-400 mb-1">
                      {call.function_name}
                    </div>
                    <pre className="text-xs whitespace-pre-wrap font-mono overflow-x-auto max-h-32 overflow-y-auto">
                      {JSON.stringify(call.arguments, null, 2)}
                    </pre>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Observation */}
          {step.observation && step.observation.results.length > 0 && (
            <div className="border-t border-border p-3">
              <h5 className="text-xs font-medium text-muted-foreground mb-2 flex items-center gap-1">
                <CheckCircle className="w-3 h-3" />
                Observation
              </h5>
              {step.observation.results.map((result, idx) => (
                <pre
                  key={idx}
                  className="text-xs whitespace-pre-wrap font-mono bg-muted rounded p-2 overflow-x-auto max-h-64 overflow-y-auto"
                >
                  {result.content}
                </pre>
              ))}
            </div>
          )}

          {/* Metrics */}
          {step.metrics && (
            <div className="border-t border-border px-3 py-2 bg-muted/30 flex gap-4 text-xs">
              <span>
                <span className="text-muted-foreground">Prompt:</span>{' '}
                {step.metrics.prompt_tokens.toLocaleString()}
              </span>
              <span>
                <span className="text-muted-foreground">Completion:</span>{' '}
                {step.metrics.completion_tokens.toLocaleString()}
              </span>
              <span>
                <span className="text-muted-foreground">Cost:</span>{' '}
                {formatCost(step.metrics.cost_usd)}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

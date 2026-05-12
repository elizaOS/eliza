import type { TrialStatus } from '../types/metrics'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Search, X } from 'lucide-react'

interface FilterBarProps {
  searchQuery: string
  onSearchChange: (query: string) => void
  agents: string[]
  selectedAgents: string[]
  onAgentsChange: (agents: string[]) => void
  models: string[]
  selectedModels: string[]
  onModelsChange: (models: string[]) => void
  statuses: TrialStatus[]
  selectedStatuses: TrialStatus[]
  onStatusesChange: (statuses: TrialStatus[]) => void
  hasActiveFilters: boolean
  onClearFilters: () => void
}

const statusVariant: Record<TrialStatus, 'success' | 'destructive' | 'warning' | 'error'> = {
  pass: 'success',
  fail: 'destructive',
  error: 'error',
  timeout: 'warning',
}

export function FilterBar({
  searchQuery,
  onSearchChange,
  agents,
  selectedAgents,
  onAgentsChange,
  models,
  selectedModels,
  onModelsChange,
  selectedStatuses,
  onStatusesChange,
  hasActiveFilters,
  onClearFilters,
}: FilterBarProps) {
  const allStatuses: TrialStatus[] = ['pass', 'fail', 'error', 'timeout']

  const toggleAgent = (agent: string) => {
    if (selectedAgents.includes(agent)) {
      onAgentsChange(selectedAgents.filter((a) => a !== agent))
    } else {
      onAgentsChange([...selectedAgents, agent])
    }
  }

  const toggleModel = (model: string) => {
    if (selectedModels.includes(model)) {
      onModelsChange(selectedModels.filter((m) => m !== model))
    } else {
      onModelsChange([...selectedModels, model])
    }
  }

  const toggleStatus = (status: TrialStatus) => {
    if (selectedStatuses.includes(status)) {
      onStatusesChange(selectedStatuses.filter((s) => s !== status))
    } else {
      onStatusesChange([...selectedStatuses, status])
    }
  }

  return (
    <div className="space-y-3 mb-6">
      {/* Search */}
      <div className="flex items-center gap-4">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            type="text"
            placeholder="Search tasks, agents, models..."
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            className="pl-10"
          />
        </div>

        {hasActiveFilters && (
          <Button variant="outline" size="sm" onClick={onClearFilters}>
            <X className="w-4 h-4 mr-1" />
            Clear filters
          </Button>
        )}
      </div>

      {/* Filter chips */}
      <div className="flex flex-wrap gap-4">
        {/* Status filters */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground uppercase tracking-wide">Status:</span>
          <div className="flex gap-1">
            {allStatuses.map((status) => (
              <button
                key={status}
                onClick={() => toggleStatus(status)}
                className="focus:outline-none"
              >
                <Badge
                  variant={selectedStatuses.includes(status) ? statusVariant[status] : 'outline'}
                  className="cursor-pointer hover:opacity-80"
                >
                  {status}
                </Badge>
              </button>
            ))}
          </div>
        </div>

        {/* Agent filters */}
        {agents.length > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground uppercase tracking-wide">Agent:</span>
            <div className="flex gap-1 flex-wrap">
              {agents.map((agent) => (
                <button
                  key={agent}
                  onClick={() => toggleAgent(agent)}
                  className="focus:outline-none"
                >
                  <Badge
                    variant={selectedAgents.includes(agent) ? 'default' : 'outline'}
                    className="cursor-pointer hover:opacity-80"
                  >
                    {agent}
                  </Badge>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Model filters */}
        {models.length > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground uppercase tracking-wide">Model:</span>
            <div className="flex gap-1 flex-wrap">
              {models.map((model) => (
                <button
                  key={model}
                  onClick={() => toggleModel(model)}
                  className="focus:outline-none"
                >
                  <Badge
                    variant={selectedModels.includes(model) ? 'secondary' : 'outline'}
                    className="cursor-pointer hover:opacity-80"
                  >
                    {model.split('@')[0]}
                  </Badge>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

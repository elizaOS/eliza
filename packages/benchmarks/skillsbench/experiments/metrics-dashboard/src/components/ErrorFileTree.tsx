import { useState } from 'react'
import type { ProcessedTrial, ErrorGroup } from '../types/metrics'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { AlertCircle, ChevronRight, FileText } from 'lucide-react'
import { cn } from '@/lib/utils'

interface ErrorFileTreeProps {
  errorGroups: ErrorGroup[]
  onTrialSelect: (trial: ProcessedTrial) => void
  selectedTrialId: string | null
}

export function ErrorFileTree({ errorGroups, onTrialSelect, selectedTrialId }: ErrorFileTreeProps) {
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(
    new Set(errorGroups.map((g) => g.exceptionType))
  )

  const toggleGroup = (exceptionType: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(exceptionType)) {
        next.delete(exceptionType)
      } else {
        next.add(exceptionType)
      }
      return next
    })
  }

  if (errorGroups.length === 0) {
    return (
      <Card>
        <CardContent className="p-8 text-center text-muted-foreground">
          No errors found in the current selection
        </CardContent>
      </Card>
    )
  }

  const totalErrors = errorGroups.reduce((sum, g) => sum + g.count, 0)

  return (
    <Card>
      <CardHeader className="py-3 px-4 border-b">
        <CardTitle className="flex items-center gap-2 text-base">
          <AlertCircle className="w-4 h-4 text-destructive" />
          Errors
          <Badge variant="error">{totalErrors}</Badge>
        </CardTitle>
      </CardHeader>

      <CardContent className="p-2 max-h-[500px] overflow-y-auto font-mono text-sm">
        {errorGroups.map((group, groupIndex) => (
          <div key={group.exceptionType} className="mb-1">
            {/* Exception type node */}
            <button
              onClick={() => toggleGroup(group.exceptionType)}
              className="w-full text-left flex items-center gap-2 py-1 px-2 rounded-md hover:bg-accent transition-colors"
            >
              <span className="text-muted-foreground">
                {groupIndex === errorGroups.length - 1 ? '└' : '├'}
              </span>
              <ChevronRight
                className={cn(
                  'w-3 h-3 text-muted-foreground transition-transform',
                  expandedGroups.has(group.exceptionType) && 'rotate-90'
                )}
              />
              <Badge variant="error" className="text-xs">
                {group.exceptionType}
              </Badge>
              <span className="text-muted-foreground text-xs">({group.count})</span>
            </button>

            {/* Trial nodes */}
            {expandedGroups.has(group.exceptionType) && (
              <div className="ml-6">
                {group.trials.map((trial, trialIndex) => (
                  <button
                    key={trial.id}
                    onClick={() => onTrialSelect(trial)}
                    className={cn(
                      'w-full text-left flex items-center gap-2 py-1 px-2 rounded-md transition-colors',
                      selectedTrialId === trial.id
                        ? 'bg-accent'
                        : 'hover:bg-accent/50'
                    )}
                  >
                    <span className="text-muted-foreground">
                      {trialIndex === group.trials.length - 1 ? '└' : '├'}
                    </span>
                    <FileText className="w-3 h-3 text-muted-foreground" />
                    <span className="truncate flex-1">{trial.trialName}</span>
                    <span className="text-muted-foreground text-xs">{trial.taskName}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

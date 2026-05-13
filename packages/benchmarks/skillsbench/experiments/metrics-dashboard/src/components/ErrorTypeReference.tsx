import { useMemo } from 'react'
import { HARBOR_ERROR_TYPES, ERROR_CATEGORIES, type HarborErrorType } from '../constants/harborErrors'
import type { ProcessedTrial } from '../types/metrics'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Layers } from 'lucide-react'

interface ErrorTypeReferenceProps {
  trials: ProcessedTrial[]
  onErrorTypeSelect?: (errorType: string) => void
}

const categoryColors: Record<string, string> = {
  trial: 'bg-orange-500',
  llm: 'bg-purple-500',
  verifier: 'bg-blue-500',
  port: 'bg-gray-500',
  unknown: 'bg-yellow-500',
}

export function ErrorTypeReference({ trials, onErrorTypeSelect }: ErrorTypeReferenceProps) {
  // Count occurrences of each error type
  const errorCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const trial of trials) {
      if (trial.exceptionInfo) {
        const errType = trial.exceptionInfo.exception_type
        counts.set(errType, (counts.get(errType) || 0) + 1)
      }
    }
    return counts
  }, [trials])

  // Group errors by category
  const groupedErrors = useMemo(() => {
    const groups: Record<string, (HarborErrorType & { count: number })[]> = {}

    for (const category of Object.keys(ERROR_CATEGORIES)) {
      groups[category] = []
    }
    groups['unknown'] = []

    // Add known harbor errors
    for (const errorType of HARBOR_ERROR_TYPES) {
      const count = errorCounts.get(errorType.name) || 0
      groups[errorType.category].push({ ...errorType, count })
    }

    // Add any unknown errors found in data
    for (const [errorName, count] of errorCounts) {
      const isKnown = HARBOR_ERROR_TYPES.some((e) => e.name === errorName)
      if (!isKnown) {
        groups['unknown'].push({
          name: errorName,
          category: 'trial',
          description: 'Unknown error type not defined in harbor',
          sourceFile: 'unknown',
          count,
        })
      }
    }

    return groups
  }, [errorCounts])

  const totalErrors = Array.from(errorCounts.values()).reduce((a, b) => a + b, 0)

  return (
    <Card>
      <CardHeader className="py-3 px-4 border-b">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <Layers className="w-4 h-4" />
            Harbor Error Types
          </CardTitle>
          <span className="text-sm text-muted-foreground">
            {totalErrors} errors in data
          </span>
        </div>
      </CardHeader>

      <CardContent className="p-4 space-y-4 max-h-[600px] overflow-y-auto">
        {Object.entries(ERROR_CATEGORIES).map(([category, { label }]) => {
          const errors = groupedErrors[category]
          if (!errors || errors.length === 0) return null

          const categoryTotal = errors.reduce((sum, e) => sum + e.count, 0)

          return (
            <div key={category}>
              <div className="flex items-center gap-2 mb-2">
                <div className={`w-2 h-2 rounded-full ${categoryColors[category]}`} />
                <span className="text-sm font-medium">{label}</span>
                {categoryTotal > 0 && (
                  <span className="text-xs text-muted-foreground">({categoryTotal})</span>
                )}
              </div>
              <div className="space-y-1 ml-4">
                {errors.map((error) => (
                  <button
                    key={error.name}
                    onClick={() => error.count > 0 && onErrorTypeSelect?.(error.name)}
                    disabled={error.count === 0}
                    className={`w-full text-left p-2 rounded-md transition-colors ${
                      error.count > 0
                        ? 'hover:bg-accent cursor-pointer'
                        : 'opacity-50 cursor-default'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className={`text-sm ${error.count > 0 ? '' : 'text-muted-foreground'}`}>
                        {error.name}
                      </span>
                      {error.count > 0 ? (
                        <Badge variant="error">{error.count}</Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">{error.description}</p>
                  </button>
                ))}
              </div>
            </div>
          )
        })}

        {/* Unknown errors */}
        {groupedErrors['unknown']?.length > 0 && (
          <div>
            <div className="flex items-center gap-2 mb-2">
              <div className={`w-2 h-2 rounded-full ${categoryColors['unknown']}`} />
              <span className="text-sm font-medium">Unknown</span>
              <span className="text-xs text-muted-foreground">
                ({groupedErrors['unknown'].reduce((sum, e) => sum + e.count, 0)})
              </span>
            </div>
            <div className="space-y-1 ml-4">
              {groupedErrors['unknown'].map((error) => (
                <button
                  key={error.name}
                  onClick={() => onErrorTypeSelect?.(error.name)}
                  className="w-full text-left p-2 rounded-md hover:bg-accent cursor-pointer transition-colors"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm">{error.name}</span>
                    <Badge variant="warning">{error.count}</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">{error.description}</p>
                </button>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

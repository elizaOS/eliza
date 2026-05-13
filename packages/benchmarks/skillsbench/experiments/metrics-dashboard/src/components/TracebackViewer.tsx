import type { ProcessedTrial } from '../types/metrics'
import { formatDate, formatDuration } from '../utils/formatters'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { X, FileText } from 'lucide-react'

interface TracebackViewerProps {
  trial: ProcessedTrial | null
  onClose: () => void
}

const statusVariant: Record<string, 'success' | 'destructive' | 'warning' | 'error'> = {
  pass: 'success',
  fail: 'destructive',
  error: 'error',
  timeout: 'warning',
}

export function TracebackViewer({ trial, onClose }: TracebackViewerProps) {
  if (!trial) {
    return (
      <Card className="h-full">
        <CardContent className="h-full flex items-center justify-center p-8">
          <div className="text-center text-muted-foreground">
            <FileText className="w-12 h-12 mx-auto mb-4 opacity-50" />
            <p>Select a trial to view details</p>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="h-full flex flex-col">
      {/* Header */}
      <CardHeader className="py-3 px-4 flex-row items-center justify-between space-y-0 border-b">
        <div className="flex items-center gap-2 min-w-0">
          <Badge variant={statusVariant[trial.status]}>{trial.status}</Badge>
          <span className="font-medium truncate">{trial.trialName}</span>
        </div>
        <Button variant="ghost" size="icon" onClick={onClose} className="h-8 w-8">
          <X className="w-4 h-4" />
        </Button>
      </CardHeader>

      {/* Trial info */}
      <div className="px-4 py-3 border-b bg-muted/30">
        <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <div>
            <span className="text-muted-foreground">Task:</span>
            <span className="ml-2 font-medium">{trial.taskName}</span>
          </div>
          <div>
            <span className="text-muted-foreground">Agent:</span>
            <span className="ml-2">{trial.agent}</span>
          </div>
          <div>
            <span className="text-muted-foreground">Model:</span>
            <span className="ml-2 text-xs">{trial.model}</span>
          </div>
          <div>
            <span className="text-muted-foreground">Duration:</span>
            <span className="ml-2">{formatDuration(trial.durationMs)}</span>
          </div>
          <div>
            <span className="text-muted-foreground">Started:</span>
            <span className="ml-2 text-xs">{formatDate(trial.startedAt)}</span>
          </div>
          <div>
            <span className="text-muted-foreground">Reward:</span>
            <span className={`ml-2 font-medium ${trial.reward !== null && trial.reward >= 1.0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
              {trial.reward?.toFixed(2) ?? '-'}
            </span>
          </div>
        </div>
      </div>

      {/* Exception info */}
      {trial.exceptionInfo ? (
        <div className="flex-1 overflow-auto">
          <div className="px-4 py-3 border-b">
            <div className="flex items-center gap-2 mb-2">
              <Badge variant="error">{trial.exceptionInfo.exception_type}</Badge>
              <span className="text-xs text-muted-foreground">
                {formatDate(trial.exceptionInfo.occurred_at)}
              </span>
            </div>
            <p className="text-sm">{trial.exceptionInfo.exception_message}</p>
          </div>

          <div className="p-4">
            <h4 className="text-xs text-muted-foreground uppercase tracking-wide mb-2">Traceback</h4>
            <div className="traceback bg-muted p-4 rounded-md border overflow-x-auto text-xs">
              {trial.exceptionInfo.exception_traceback}
            </div>
          </div>
        </div>
      ) : (
        <CardContent className="flex-1 flex items-center justify-center">
          <p className="text-muted-foreground">No exception information available</p>
        </CardContent>
      )}
    </Card>
  )
}

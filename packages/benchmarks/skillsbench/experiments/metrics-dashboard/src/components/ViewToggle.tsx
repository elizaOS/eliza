import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'

export type ViewMode = 'table' | 'errors' | 'error-types'

interface ViewToggleProps {
  viewMode: ViewMode
  onViewChange: (mode: ViewMode) => void
  errorCount: number
}

export function ViewToggle({ viewMode, onViewChange, errorCount }: ViewToggleProps) {
  return (
    <Tabs value={viewMode} onValueChange={(v) => onViewChange(v as ViewMode)}>
      <TabsList>
        <TabsTrigger value="table">Table View</TabsTrigger>
        <TabsTrigger value="errors" className="flex items-center gap-2">
          Errors
          {errorCount > 0 && (
            <Badge variant="error" className="ml-1">
              {errorCount}
            </Badge>
          )}
        </TabsTrigger>
        <TabsTrigger value="error-types">All Error Types</TabsTrigger>
      </TabsList>
    </Tabs>
  )
}

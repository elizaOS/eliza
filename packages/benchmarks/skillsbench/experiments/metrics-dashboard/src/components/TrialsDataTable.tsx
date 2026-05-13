import { ColumnDef } from '@tanstack/react-table'
import type { ProcessedTrial } from '../types/metrics'
import { DataTable } from '@/components/ui/data-table'
import { Badge } from '@/components/ui/badge'

interface TrialsDataTableProps {
  trials: ProcessedTrial[]
  onTrialSelect: (trial: ProcessedTrial) => void
}

const statusVariant: Record<string, 'success' | 'destructive' | 'warning' | 'error'> = {
  pass: 'success',
  fail: 'destructive',
  error: 'error',
  timeout: 'warning',
}

const columns: ColumnDef<ProcessedTrial>[] = [
  {
    accessorKey: 'status',
    header: 'Status',
    cell: ({ row }) => {
      const status = row.getValue('status') as string
      return (
        <Badge variant={statusVariant[status] || 'outline'}>
          {status}
        </Badge>
      )
    },
    enableGrouping: true,
  },
  {
    accessorKey: 'taskName',
    header: 'Task',
    cell: ({ row }) => (
      <span className="font-medium">{row.getValue('taskName')}</span>
    ),
    enableGrouping: true,
  },
  {
    accessorKey: 'agent',
    header: 'Agent',
    enableGrouping: true,
  },
  {
    accessorKey: 'model',
    header: 'Model',
    enableGrouping: true,
  },
  {
    accessorKey: 'reward',
    header: 'Reward',
    cell: ({ row }) => {
      const reward = row.getValue('reward') as number | null
      if (reward === null) return <span className="text-muted-foreground">—</span>
      return (
        <span className={reward === 1 ? 'text-green-600 dark:text-green-400 font-medium' : ''}>
          {reward.toFixed(2)}
        </span>
      )
    },
  },
  {
    accessorKey: 'costUsd',
    header: 'Cost',
    cell: ({ row }) => {
      const cost = row.getValue('costUsd') as number | null
      if (cost === null) return <span className="text-muted-foreground">—</span>
      return `$${cost.toFixed(4)}`
    },
  },
  {
    accessorKey: 'durationMs',
    header: 'Duration',
    cell: ({ row }) => {
      const ms = row.getValue('durationMs') as number
      if (ms < 1000) return `${ms}ms`
      if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
      return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`
    },
  },
  {
    accessorKey: 'inputTokens',
    header: 'Input Tokens',
    cell: ({ row }) => {
      const tokens = row.getValue('inputTokens') as number | null
      if (tokens === null) return <span className="text-muted-foreground">—</span>
      return tokens.toLocaleString()
    },
  },
  {
    accessorKey: 'outputTokens',
    header: 'Output Tokens',
    cell: ({ row }) => {
      const tokens = row.getValue('outputTokens') as number | null
      if (tokens === null) return <span className="text-muted-foreground">—</span>
      return tokens.toLocaleString()
    },
  },
  {
    accessorKey: 'jobName',
    header: 'Job',
    enableGrouping: true,
  },
  {
    accessorKey: 'exceptionInfo',
    header: 'Error',
    cell: ({ row }) => {
      const exception = row.original.exceptionInfo
      if (!exception) return null
      return (
        <span className="text-destructive text-xs truncate max-w-[200px] block">
          {exception.exception_type}
        </span>
      )
    },
  },
]

export function TrialsDataTable({ trials, onTrialSelect }: TrialsDataTableProps) {
  return (
    <DataTable
      columns={columns}
      data={trials}
      searchKey="taskName"
      searchPlaceholder="Search tasks..."
      groupableColumns={['status', 'taskName', 'agent', 'model', 'jobName']}
      onRowClick={onTrialSelect}
    />
  )
}

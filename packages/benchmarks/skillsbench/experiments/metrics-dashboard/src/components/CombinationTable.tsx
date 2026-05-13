import { useState, useMemo } from 'react';
import type { ProcessedTrial } from '../types/metrics';
import { formatDuration, formatCost, formatTokens } from '../utils/formatters';

type SortColumn = 'task' | 'agent' | 'model' | 'reward' | 'status' | 'duration' | 'cost' | 'tokens';
type SortDirection = 'asc' | 'desc';

interface CombinationTableProps {
  trials: ProcessedTrial[];
  onTrialSelect: (trial: ProcessedTrial) => void;
}

export function CombinationTable({ trials, onTrialSelect }: CombinationTableProps) {
  const [sortColumn, setSortColumn] = useState<SortColumn>('task');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');

  const handleSort = (column: SortColumn) => {
    if (sortColumn === column) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortColumn(column);
      setSortDirection('asc');
    }
  };

  const sortedTrials = useMemo(() => {
    return [...trials].sort((a, b) => {
      let comparison = 0;

      switch (sortColumn) {
        case 'task':
          comparison = a.taskName.localeCompare(b.taskName);
          break;
        case 'agent':
          comparison = a.agent.localeCompare(b.agent);
          break;
        case 'model':
          comparison = a.model.localeCompare(b.model);
          break;
        case 'reward':
          comparison = (a.reward ?? -1) - (b.reward ?? -1);
          break;
        case 'status':
          comparison = a.status.localeCompare(b.status);
          break;
        case 'duration':
          comparison = a.durationMs - b.durationMs;
          break;
        case 'cost':
          comparison = (a.costUsd ?? 0) - (b.costUsd ?? 0);
          break;
        case 'tokens':
          comparison = (a.inputTokens ?? 0) - (b.inputTokens ?? 0);
          break;
      }

      return sortDirection === 'asc' ? comparison : -comparison;
    });
  }, [trials, sortColumn, sortDirection]);

  const SortIcon = ({ column }: { column: SortColumn }) => {
    if (sortColumn !== column) {
      return (
        <svg className="w-3 h-3 text-muted opacity-0 group-hover:opacity-100" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M7 15l5 5 5-5M7 9l5-5 5 5" />
        </svg>
      );
    }
    return (
      <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        {sortDirection === 'asc' ? <path d="M7 14l5-5 5 5" /> : <path d="M7 10l5 5 5-5" />}
      </svg>
    );
  };

  const StatusBadge = ({ status }: { status: ProcessedTrial['status'] }) => {
    return <span className={`badge badge-${status}`}>{status}</span>;
  };

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="bg-card">
            <tr>
              <th className="table-header group" onClick={() => handleSort('task')}>
                <span className="flex items-center gap-1">Task <SortIcon column="task" /></span>
              </th>
              <th className="table-header group" onClick={() => handleSort('agent')}>
                <span className="flex items-center gap-1">Agent <SortIcon column="agent" /></span>
              </th>
              <th className="table-header group" onClick={() => handleSort('model')}>
                <span className="flex items-center gap-1">Model <SortIcon column="model" /></span>
              </th>
              <th className="table-header group" onClick={() => handleSort('reward')}>
                <span className="flex items-center gap-1">Reward <SortIcon column="reward" /></span>
              </th>
              <th className="table-header group" onClick={() => handleSort('status')}>
                <span className="flex items-center gap-1">Status <SortIcon column="status" /></span>
              </th>
              <th className="table-header group" onClick={() => handleSort('duration')}>
                <span className="flex items-center gap-1">Duration <SortIcon column="duration" /></span>
              </th>
              <th className="table-header group" onClick={() => handleSort('cost')}>
                <span className="flex items-center gap-1">Cost <SortIcon column="cost" /></span>
              </th>
              <th className="table-header group" onClick={() => handleSort('tokens')}>
                <span className="flex items-center gap-1">Tokens <SortIcon column="tokens" /></span>
              </th>
              <th className="table-header">Error</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {sortedTrials.map((trial) => (
              <tr
                key={trial.id}
                className="hover:bg-card/50 cursor-pointer"
                onClick={() => onTrialSelect(trial)}
              >
                <td className="table-cell font-medium">{trial.taskName}</td>
                <td className="table-cell text-muted">{trial.agent}</td>
                <td className="table-cell text-muted text-xs">{trial.model.split('@')[0]}</td>
                <td className="table-cell">
                  {trial.reward !== null ? (
                    <span className={trial.reward >= 1.0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}>
                      {trial.reward.toFixed(2)}
                    </span>
                  ) : (
                    <span className="text-muted">-</span>
                  )}
                </td>
                <td className="table-cell">
                  <StatusBadge status={trial.status} />
                </td>
                <td className="table-cell text-muted">{formatDuration(trial.durationMs)}</td>
                <td className="table-cell text-muted">{formatCost(trial.costUsd)}</td>
                <td className="table-cell text-muted text-xs">
                  {trial.inputTokens !== null && (
                    <>
                      <span title="Input">{formatTokens(trial.inputTokens)}</span>
                      <span className="mx-1">/</span>
                      <span title="Output">{formatTokens(trial.outputTokens)}</span>
                    </>
                  )}
                </td>
                <td className="table-cell">
                  {trial.exceptionInfo && (
                    <span className="badge badge-error text-xs">
                      {trial.exceptionInfo.exception_type.replace('Error', '')}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {sortedTrials.length === 0 && (
        <div className="p-8 text-center text-muted">
          No trials match the current filters
        </div>
      )}
    </div>
  );
}

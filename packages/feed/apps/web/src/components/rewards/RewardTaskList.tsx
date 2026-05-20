'use client';

import { Check } from 'lucide-react';

export interface RewardTask {
  id: string;
  title: string;
  description: string;
  points: number;
  completed: boolean;
  action: string;
}

interface RewardTaskListProps {
  tasks: RewardTask[];
  onTaskClick: (taskId: string, action: string) => void;
  /**
   * Variant for different screen sizes:
   * - 'desktop': slightly larger padding (px-4 py-3)
   * - 'mobile': slightly smaller padding (px-3 py-2.5)
   */
  variant?: 'desktop' | 'mobile';
}

/**
 * RewardTaskList - Displays a list of reward tasks with their completion status.
 *
 * Used on the rewards page for both desktop and mobile views to avoid
 * code duplication.
 */
export function RewardTaskList({
  tasks,
  onTaskClick,
  variant = 'desktop',
}: RewardTaskListProps) {
  const paddingClass = variant === 'desktop' ? 'px-4 py-3' : 'px-3 py-2.5';

  return (
    <div className="space-y-2">
      {tasks.map((task) => (
        <button
          key={task.id}
          onClick={
            task.completed ? undefined : () => onTaskClick(task.id, task.action)
          }
          aria-disabled={task.completed}
          className={`flex w-full items-center justify-between rounded-md border text-left transition-colors ${paddingClass} ${
            task.completed
              ? 'cursor-default border-green-500/30 bg-green-500/5'
              : 'cursor-pointer border-border hover:bg-muted/30'
          }`}
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="font-medium text-foreground text-sm">
                {task.title}
              </span>
              {task.completed && <Check className="h-4 w-4 text-green-500" />}
            </div>
            <p className="truncate text-muted-foreground text-xs">
              {task.description}
            </p>
          </div>
          <span
            className={`${variant === 'desktop' ? 'ml-4' : 'ml-3'} font-medium text-sm ${
              task.completed ? 'text-green-500' : 'text-muted-foreground'
            }`}
          >
            {task.completed ? `✓ ${task.points}` : `+${task.points}`}
          </span>
        </button>
      ))}
    </div>
  );
}

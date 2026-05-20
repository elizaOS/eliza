'use client';

interface AchievementCardProps {
  title: string;
  description: string;
  badge: 'Bronze' | 'Silver' | 'Gold';
  points: number;
  status: 'completed' | 'in-progress' | 'locked';
  progress?: { current: number; total: number };
}

export function AchievementCard({
  title,
  description,
  badge,
  points,
  status,
  progress,
}: AchievementCardProps) {
  const isLocked = status === 'locked';
  const isCompleted = status === 'completed';
  const isInProgress = status === 'in-progress';
  const percentage = progress
    ? Math.round((progress.current / progress.total) * 100)
    : 0;

  const getBadgeStyles = () => {
    if (badge === 'Bronze')
      return 'bg-gradient-to-br from-amber-600 to-amber-800 text-amber-50';
    if (badge === 'Silver')
      return 'bg-gradient-to-br from-slate-400 to-slate-600 text-white';
    return 'bg-gradient-to-br from-yellow-400 via-amber-300 to-yellow-500 text-amber-900 shadow-[0_0_8px_rgba(251,191,36,0.3)]';
  };

  return (
    <div
      className={`border border-border p-3 transition-all ${
        isCompleted
          ? 'border-emerald-500/20 bg-emerald-500/5'
          : isInProgress
            ? 'bg-card'
            : 'border-dashed bg-muted/20'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3
              className={`font-semibold text-sm ${
                isCompleted
                  ? 'text-emerald-500'
                  : isLocked
                    ? 'text-muted-foreground/70'
                    : 'text-foreground'
              }`}
            >
              {title}
            </h3>
            <span
              className={`rounded-full px-1.5 py-0.5 font-bold text-[9px] uppercase tracking-wide ${
                isLocked
                  ? 'bg-muted text-muted-foreground/50'
                  : getBadgeStyles()
              }`}
            >
              {badge}
            </span>
          </div>
          <p
            className={`mt-0.5 text-xs ${isLocked ? 'text-muted-foreground/50' : 'text-muted-foreground'}`}
          >
            {description}
          </p>
        </div>
        {points > 0 &&
          (isCompleted ? (
            <span className="shrink-0 rounded-full bg-emerald-500/15 px-2 py-0.5 font-bold text-[11px] text-emerald-500">
              +{points} rep ✓
            </span>
          ) : isLocked ? (
            <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 font-bold text-[11px] text-muted-foreground/50">
              +{points} rep
            </span>
          ) : (
            <span className="shrink-0 rounded-full bg-amber-500/10 px-2 py-0.5 font-bold text-[11px] text-amber-500">
              +{points} rep
            </span>
          ))}
      </div>

      {progress && isInProgress && (
        <div className="mt-2.5">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-muted-foreground tabular-nums">
              {progress.current} / {progress.total}
            </span>
            {percentage >= 75 && (
              <span className="font-medium text-[11px] text-amber-500">
                Almost there!
              </span>
            )}
          </div>
          <div className="mt-1 h-1.5 w-full bg-muted">
            <div
              className={`h-full transition-all ${
                percentage >= 67
                  ? 'bg-gradient-to-r from-amber-500 to-yellow-400'
                  : 'bg-amber-500'
              }`}
              style={{ width: `${percentage}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

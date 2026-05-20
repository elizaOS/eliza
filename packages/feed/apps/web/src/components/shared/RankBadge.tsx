/**
 * Rank badge component for displaying leaderboard rankings.
 *
 * Shows visual badges for top-ranked users:
 * - Rank 1: Gold trophy badge
 * - Ranks 2-3: Silver medal badge
 * - Ranks 4-10: Bronze award badge
 *
 * Returns null for ranks above 10. Supports multiple sizes and optional label.
 *
 * @param props - RankBadge component props
 * @returns Rank badge element or null if rank > 10
 *
 * @example
 * ```tsx
 * <RankBadge rank={1} size="lg" showLabel />
 * ```
 */

import { Award, Medal, Trophy } from 'lucide-react';

interface RankBadgeProps {
  rank: number;
  size?: 'sm' | 'md' | 'lg';
  showLabel?: boolean;
  className?: string;
}

export function RankBadge({
  rank,
  size = 'md',
  showLabel = true,
  className = '',
}: RankBadgeProps) {
  // Only show badge for top 10
  if (rank > 10) {
    return null;
  }

  // Determine badge type and color
  let BadgeIcon: typeof Trophy | typeof Medal | typeof Award;
  let badgeColor: string;
  let badgeLabel: string;

  if (rank === 1) {
    BadgeIcon = Trophy;
    badgeColor = 'text-foreground';
    badgeLabel = '1st Place';
  } else if (rank <= 3) {
    BadgeIcon = Medal;
    badgeColor = 'text-muted-foreground';
    badgeLabel = `${rank}${rank === 2 ? 'nd' : 'rd'} Place`;
  } else {
    BadgeIcon = Award;
    badgeColor = 'text-muted-foreground';
    badgeLabel = `Top ${rank}`;
  }

  // Size classes
  const sizeClasses = {
    sm: 'w-4 h-4',
    md: 'w-6 h-6',
    lg: 'w-8 h-8',
  };

  const textSizeClasses = {
    sm: 'text-xs',
    md: 'text-sm',
    lg: 'text-base',
  };

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <div className={`relative ${sizeClasses[size]}`}>
        <BadgeIcon
          className={`${sizeClasses[size]} ${badgeColor}`}
          fill="currentColor"
          strokeWidth={1.5}
        />
      </div>
      {showLabel && (
        <span
          className={`font-semibold ${badgeColor} ${textSizeClasses[size]}`}
        >
          {badgeLabel}
        </span>
      )}
    </div>
  );
}

/**
 * Rank number component displaying rank with special styling for top ranks.
 *
 * Shows rank number in a circular badge with gradient backgrounds:
 * - Rank 1: Yellow gradient
 * - Ranks 2-3: Gray gradient
 * - Ranks 4-10: Amber gradient
 * - Other ranks: Default gray
 *
 * @param props - RankNumber component props
 * @returns Rank number badge element
 *
 * @example
 * ```tsx
 * <RankNumber rank={5} size="md" />
 * ```
 */
interface RankNumberProps {
  rank: number;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

export function RankNumber({
  rank,
  size = 'md',
  className = '',
}: RankNumberProps) {
  const sizeClasses = {
    sm: 'w-6 h-6 text-xs',
    md: 'w-8 h-8 text-sm',
    lg: 'w-10 h-10 text-base',
  };

  let bgColor = 'bg-muted';
  let textColor = 'text-muted-foreground';

  if (rank <= 3) {
    bgColor = 'bg-foreground';
    textColor = 'text-background';
  } else if (rank <= 10) {
    bgColor = 'bg-muted';
    textColor = 'text-foreground';
  }

  return (
    <div
      className={`${sizeClasses[size]} ${bgColor} ${textColor} flex items-center justify-center rounded-full font-bold ${className}`}
    >
      {rank}
    </div>
  );
}

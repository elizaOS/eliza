/**
 * Reputation badge component for displaying user reputation trust levels.
 *
 * Displays a badge indicating the user's trust level based on reputation points:
 * - Newcomer: < 1000 points (Gray)
 * - Trusted: 1000-4999 points (Blue)
 * - Veteran: 5000-9999 points (Purple)
 * - Elite: 10000+ points (Gold)
 *
 * Features:
 * - Trust level display
 * - Size variants (sm, md, lg)
 * - Optional label text
 * - Color-coded by level
 * - Icon display
 * - Elite level animation
 *
 * @param props - ReputationBadge component props
 * @returns Reputation badge element
 *
 * @example
 * ```tsx
 * <ReputationBadge
 *   reputationPoints={5000}
 *   size="md"
 *   showLabel={true}
 * />
 * ```
 */

import type { ShieldAlert } from 'lucide-react';
import { Award, Shield, ShieldCheck } from 'lucide-react';

interface ReputationBadgeProps {
  reputationPoints: number;
  size?: 'sm' | 'md' | 'lg';
  showLabel?: boolean;
  className?: string;
}

/**
 * Trust level type based on reputation points.
 */
type TrustLevel = 'newcomer' | 'trusted' | 'veteran' | 'elite';

/**
 * Get trust level from reputation points.
 *
 * Determines the trust level based on reputation point thresholds.
 *
 * @param points - Reputation points
 * @returns Trust level
 */
function getTrustLevel(points: number): TrustLevel {
  if (points >= 10000) return 'elite';
  if (points >= 5000) return 'veteran';
  if (points >= 1000) return 'trusted';
  return 'newcomer';
}

export function ReputationBadge({
  reputationPoints,
  size = 'md',
  showLabel = true,
  className = '',
}: ReputationBadgeProps) {
  const trustLevel = getTrustLevel(reputationPoints);

  // Determine badge type and styling
  let BadgeIcon:
    | typeof Shield
    | typeof ShieldCheck
    | typeof ShieldAlert
    | typeof Award;
  let badgeColor: string;
  let badgeLabel: string;
  let glowColor: string;

  switch (trustLevel) {
    case 'elite':
      BadgeIcon = Award;
      badgeColor = 'text-yellow-500';
      glowColor = 'shadow-yellow-500/50';
      badgeLabel = 'Elite';
      break;
    case 'veteran':
      BadgeIcon = ShieldCheck;
      badgeColor = 'text-purple-500';
      glowColor = 'shadow-purple-500/50';
      badgeLabel = 'Veteran';
      break;
    case 'trusted':
      BadgeIcon = ShieldCheck;
      badgeColor = 'text-blue-500';
      glowColor = 'shadow-blue-500/50';
      badgeLabel = 'Trusted';
      break;
    case 'newcomer':
    default:
      BadgeIcon = Shield;
      badgeColor = 'text-gray-400';
      glowColor = 'shadow-gray-400/50';
      badgeLabel = 'Newcomer';
      break;
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
          className={`${sizeClasses[size]} ${badgeColor} drop-shadow-lg ${glowColor}`}
          fill="currentColor"
          strokeWidth={1.5}
        />
        {trustLevel === 'elite' && (
          <div className="absolute inset-0 animate-pulse">
            <BadgeIcon
              className={`${sizeClasses[size]} ${badgeColor} opacity-50`}
              fill="currentColor"
            />
          </div>
        )}
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
 * ReputationScore Component
 *
 * Displays the reputation points with visual styling
 */
interface ReputationScoreProps {
  reputationPoints: number;
  size?: 'sm' | 'md' | 'lg';
  showChange?: boolean;
  change?: number;
  className?: string;
}

export function ReputationScore({
  reputationPoints,
  size = 'md',
  showChange = false,
  change = 0,
  className = '',
}: ReputationScoreProps) {
  const trustLevel = getTrustLevel(reputationPoints);

  const sizeClasses = {
    sm: 'text-sm',
    md: 'text-lg',
    lg: 'text-2xl',
  };

  let scoreColor = 'text-gray-400';

  switch (trustLevel) {
    case 'elite':
      scoreColor = 'text-yellow-500';
      break;
    case 'veteran':
      scoreColor = 'text-purple-500';
      break;
    case 'trusted':
      scoreColor = 'text-blue-500';
      break;
    case 'newcomer':
    default:
      scoreColor = 'text-gray-400';
      break;
  }

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <span className={`font-bold ${scoreColor} ${sizeClasses[size]}`}>
        {reputationPoints.toLocaleString()}
      </span>
      {showChange && change !== 0 && (
        <span
          className={`font-medium text-xs ${
            change > 0 ? 'text-green-500' : 'text-red-500'
          }`}
        >
          {change > 0 ? '+' : ''}
          {change}
        </span>
      )}
    </div>
  );
}

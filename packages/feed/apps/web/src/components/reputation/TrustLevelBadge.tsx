/**
 * Trust level badge component for displaying reputation trust level.
 *
 * Displays a badge showing the current trust level (Newcomer, Trusted,
 * Veteran, Elite) based on reputation points. Includes progress indicator
 * toward the next level and color-coded styling.
 *
 * Features:
 * - Trust level display
 * - Progress toward next level
 * - Size variants (sm, md, lg)
 * - Color-coded by level
 * - Icon display
 *
 * @param props - TrustLevelBadge component props
 * @returns Trust level badge element
 *
 * @example
 * ```tsx
 * <TrustLevelBadge
 *   reputationPoints={5000}
 *   size="md"
 *   showProgress={true}
 * />
 * ```
 */
import { Award, Shield, ShieldCheck, TrendingUp } from "lucide-react";

interface TrustLevelBadgeProps {
  reputationPoints: number;
  size?: "sm" | "md" | "lg";
  showProgress?: boolean;
  className?: string;
}

/**
 * Trust level information structure.
 */
interface TrustLevelInfo {
  level: "newcomer" | "trusted" | "veteran" | "elite";
  label: string;
  min: number;
  max: number;
  color: string;
  bgColor: string;
  Icon: typeof Shield | typeof ShieldCheck | typeof Award;
}

/**
 * Available trust levels with thresholds and styling.
 */
const TRUST_LEVELS: TrustLevelInfo[] = [
  {
    level: "newcomer",
    label: "Newcomer",
    min: 0,
    max: 999,
    color: "text-gray-400",
    bgColor: "bg-gray-400",
    Icon: Shield,
  },
  {
    level: "trusted",
    label: "Trusted",
    min: 1000,
    max: 4999,
    color: "text-blue-500",
    bgColor: "bg-blue-500",
    Icon: ShieldCheck,
  },
  {
    level: "veteran",
    label: "Veteran",
    min: 5000,
    max: 9999,
    color: "text-purple-500",
    bgColor: "bg-purple-500",
    Icon: ShieldCheck,
  },
  {
    level: "elite",
    label: "Elite",
    min: 10000,
    max: Number.POSITIVE_INFINITY,
    color: "text-yellow-500",
    bgColor: "bg-yellow-500",
    Icon: Award,
  },
];

function getCurrentLevel(points: number): TrustLevelInfo {
  const level = TRUST_LEVELS.find(
    (level) => points >= level.min && points <= level.max,
  );
  const defaultLevel = TRUST_LEVELS[0];
  if (!defaultLevel) {
    throw new Error("TRUST_LEVELS array is empty");
  }
  return level ?? defaultLevel;
}

function getNextLevel(currentLevel: TrustLevelInfo): TrustLevelInfo | null {
  const currentIndex = TRUST_LEVELS.indexOf(currentLevel);
  if (currentIndex < TRUST_LEVELS.length - 1 && currentIndex >= 0) {
    const nextLevel = TRUST_LEVELS[currentIndex + 1];
    return nextLevel ?? null;
  }
  return null;
}

function calculateProgress(
  points: number,
  currentLevel: TrustLevelInfo,
): number {
  if (currentLevel.max === Number.POSITIVE_INFINITY) return 100;

  const levelRange = currentLevel.max - currentLevel.min + 1;
  const pointsInLevel = points - currentLevel.min;
  return Math.min(100, Math.round((pointsInLevel / levelRange) * 100));
}

export function TrustLevelBadge({
  reputationPoints,
  size = "md",
  showProgress = true,
  className = "",
}: TrustLevelBadgeProps) {
  const currentLevel = getCurrentLevel(reputationPoints);
  const nextLevel = getNextLevel(currentLevel);
  const progress = calculateProgress(reputationPoints, currentLevel);

  const { Icon, color, bgColor, label } = currentLevel;

  // Size classes
  const sizeClasses = {
    sm: "w-4 h-4",
    md: "w-6 h-6",
    lg: "w-8 h-8",
  };

  const textSizeClasses = {
    sm: "text-xs",
    md: "text-sm",
    lg: "text-base",
  };

  return (
    <div data-testid="trust-level-badge" className={`space-y-2 ${className}`}>
      {/* Badge and Label */}
      <div className="flex items-center gap-2">
        <div className={`relative ${sizeClasses[size]}`}>
          <Icon
            className={`${sizeClasses[size]} ${color} drop-shadow-lg`}
            fill="currentColor"
            strokeWidth={1.5}
          />
          {currentLevel.level === "elite" && (
            <div className="absolute inset-0 animate-pulse">
              <Icon
                className={`${sizeClasses[size]} ${color} opacity-50`}
                fill="currentColor"
              />
            </div>
          )}
        </div>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className={`font-semibold ${color} ${textSizeClasses[size]}`}>
              {label}
            </span>
            <span className="text-gray-500 text-xs">
              {reputationPoints.toLocaleString()} reputation
            </span>
          </div>
        </div>
      </div>

      {/* Progress Bar */}
      {showProgress && nextLevel && (
        <div className="space-y-1">
          <div className="h-2 w-full overflow-hidden rounded-full bg-gray-700/50">
            <div
              className={`h-full ${bgColor} transition-all duration-300 ease-out`}
              style={{ width: `${progress}%` }}
            />
          </div>
          <div className="flex items-center justify-between text-gray-500 text-xs">
            <span>Progress to {nextLevel.label}</span>
            <span className="flex items-center gap-1">
              <TrendingUp className="h-3 w-3" />
              {nextLevel.min - reputationPoints} reputation needed
            </span>
          </div>
        </div>
      )}

      {/* Max Level Indicator */}
      {showProgress && !nextLevel && (
        <div className="flex items-center gap-1 text-xs text-yellow-500">
          <Award className="h-3 w-3" />
          <span>Maximum trust level achieved!</span>
        </div>
      )}
    </div>
  );
}

/**
 * TrustLevelIcon Component
 *
 * Minimal icon-only version for compact display
 */
interface TrustLevelIconProps {
  reputationPoints: number;
  size?: "sm" | "md" | "lg";
  className?: string;
}

export function TrustLevelIcon({
  reputationPoints,
  size = "md",
  className = "",
}: TrustLevelIconProps) {
  const currentLevel = getCurrentLevel(reputationPoints);
  const { Icon, color } = currentLevel;

  const sizeClasses = {
    sm: "w-4 h-4",
    md: "w-5 h-5",
    lg: "w-6 h-6",
  };

  return (
    <Icon
      className={`${sizeClasses[size]} ${color} ${className}`}
      fill="currentColor"
      strokeWidth={1.5}
    />
  );
}

/**
 * Star rating component for interactive feedback submission.
 *
 * Provides an interactive star rating interface that converts between
 * 5-star display (UI) and 0-100 score (backend). Supports hover effects,
 * half-star ratings, and readonly display mode.
 *
 * Features:
 * - Interactive star selection
 * - Half-star support
 * - Hover effects
 * - Readonly mode
 * - Size variants (sm, md, lg)
 * - Score conversion (0-100 ↔ 0-5 stars)
 * - Label display
 *
 * @param props - StarRating component props
 * @returns Star rating element
 *
 * @example
 * ```tsx
 * <StarRating
 *   value={70}
 *   onChange={(score) => setScore(score)}
 *   size="md"
 * />
 * ```
 */
'use client';

import { cn } from '@babylon/shared';
import { Star } from 'lucide-react';
import { useState } from 'react';

interface StarRatingProps {
  value?: number; // 0-100 score
  onChange?: (score: number) => void;
  size?: 'sm' | 'md' | 'lg';
  readonly?: boolean;
  showLabel?: boolean;
  className?: string;
}

/**
 * Convert 0-100 score to 0-5 star rating.
 *
 * Rounds to nearest 0.5 for half-star display.
 *
 * @param score - Score from 0-100
 * @returns Star rating from 0-5 (rounded to 0.5)
 */
function scoreToStars(score: number): number {
  return Math.round((score / 100) * 5 * 2) / 2; // Round to nearest 0.5
}

/**
 * Convert 0-5 star rating to 0-100 score.
 *
 * @param stars - Star rating from 0-5
 * @returns Score from 0-100
 */
function starsToScore(stars: number): number {
  return Math.round((stars / 5) * 100);
}

export function StarRating({
  value = 0,
  onChange,
  size = 'md',
  readonly = false,
  showLabel = true,
  className = '',
}: StarRatingProps) {
  const currentStars = scoreToStars(value);
  const [hoveredStars, setHoveredStars] = useState<number | null>(null);

  const displayStars =
    hoveredStars !== null && !readonly ? hoveredStars : currentStars;

  const handleClick = (stars: number) => {
    if (readonly || !onChange) return;
    const newScore = starsToScore(stars);
    onChange(newScore);
  };

  const handleMouseEnter = (stars: number) => {
    if (readonly) return;
    setHoveredStars(stars);
  };

  const handleMouseLeave = () => {
    if (readonly) return;
    setHoveredStars(null);
  };

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
    <div className={cn('flex items-center gap-2', className)}>
      {/* Stars */}
      <div className="flex items-center gap-1" onMouseLeave={handleMouseLeave}>
        {[1, 2, 3, 4, 5].map((star) => {
          const isFilled = star <= Math.floor(displayStars);
          const isHalfFilled = !isFilled && star - 0.5 === displayStars;

          return (
            <button
              key={star}
              type="button"
              onClick={() => handleClick(star)}
              onMouseEnter={() => handleMouseEnter(star)}
              disabled={readonly}
              className={cn(
                'relative transition-transform',
                !readonly && 'cursor-pointer hover:scale-110',
                readonly && 'cursor-default'
              )}
              aria-label={`Rate ${star} star${star !== 1 ? 's' : ''}`}
            >
              <Star
                className={cn(
                  sizeClasses[size],
                  'transition-colors',
                  isFilled
                    ? 'text-yellow-500'
                    : isHalfFilled
                      ? 'text-yellow-500/50'
                      : 'text-gray-600'
                )}
                fill={isFilled || isHalfFilled ? 'currentColor' : 'none'}
                strokeWidth={2}
              />
            </button>
          );
        })}
      </div>

      {/* Label */}
      {showLabel && (
        <span
          className={cn(
            'font-medium text-muted-foreground',
            textSizeClasses[size]
          )}
        >
          {displayStars > 0 ? (
            <>
              {displayStars.toFixed(1)}/5
              <span className="ml-1 text-xs">({value}/100)</span>
            </>
          ) : (
            'No rating'
          )}
        </span>
      )}
    </div>
  );
}

/**
 * StarRatingCompact Component
 *
 * Read-only compact star display without label
 */
interface StarRatingCompactProps {
  score: number; // 0-100
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

export function StarRatingCompact({
  score,
  size = 'sm',
  className = '',
}: StarRatingCompactProps) {
  const stars = scoreToStars(score);

  const sizeClasses = {
    sm: 'w-3 h-3',
    md: 'w-4 h-4',
    lg: 'w-5 h-5',
  };

  return (
    <div className={cn('inline-flex items-center gap-0.5', className)}>
      {[1, 2, 3, 4, 5].map((star) => {
        const isFilled = star <= Math.floor(stars);
        const isHalfFilled = !isFilled && star - 0.5 === stars;

        return (
          <Star
            key={star}
            className={cn(
              sizeClasses[size],
              isFilled
                ? 'text-yellow-500'
                : isHalfFilled
                  ? 'text-yellow-500/50'
                  : 'text-gray-600'
            )}
            fill={isFilled || isHalfFilled ? 'currentColor' : 'none'}
          />
        );
      })}
    </div>
  );
}

/**
 * StarRatingInput Component
 *
 * Star rating with text description labels
 */

/**
 * Default rating descriptions for the 1-5 star scale.
 * Can be overridden via the `descriptions` prop.
 */
export const DEFAULT_RATING_DESCRIPTIONS: Record<number, string> = {
  1: 'Nice to have',
  2: 'Would be helpful',
  3: 'Important',
  4: 'Very important',
  5: 'Must have',
};

interface StarRatingInputProps {
  value?: number;
  onChange?: (score: number) => void;
  showDescriptions?: boolean;
  /** Custom labels for each star rating (1-5). Defaults to DEFAULT_RATING_DESCRIPTIONS. */
  descriptions?: Record<number, string>;
  className?: string;
}

export function StarRatingInput({
  value = 0,
  onChange,
  showDescriptions = true,
  descriptions = DEFAULT_RATING_DESCRIPTIONS,
  className = '',
}: StarRatingInputProps) {
  const currentStars = scoreToStars(value);
  const [hoveredStars, setHoveredStars] = useState<number | null>(null);

  // Show description for hovered stars, or current stars if not hovering
  const displayStars = hoveredStars !== null ? hoveredStars : currentStars;
  const description =
    displayStars > 0 ? descriptions[Math.ceil(displayStars)] : '';

  const handleChange = (newScore: number) => {
    if (onChange) {
      onChange(newScore);
    }
  };

  const handleMouseEnter = (stars: number) => {
    setHoveredStars(stars);
  };

  const handleMouseLeave = () => {
    setHoveredStars(null);
  };

  return (
    <div className={cn('space-y-2', className)}>
      <div onMouseLeave={handleMouseLeave} className="inline-block">
        <div className="flex items-center gap-1">
          {[1, 2, 3, 4, 5].map((star) => {
            const isFilled = star <= Math.floor(displayStars);
            const isHalfFilled = !isFilled && star - 0.5 === displayStars;

            return (
              <button
                key={star}
                type="button"
                onClick={() => handleChange(starsToScore(star))}
                onMouseEnter={() => handleMouseEnter(star)}
                className="relative cursor-pointer transition-transform hover:scale-110"
                aria-label={`Rate ${star} star${star !== 1 ? 's' : ''}`}
              >
                <Star
                  className={cn(
                    'h-8 w-8 transition-colors',
                    isFilled
                      ? 'text-yellow-500'
                      : isHalfFilled
                        ? 'text-yellow-500/50'
                        : 'text-gray-600'
                  )}
                  fill={isFilled || isHalfFilled ? 'currentColor' : 'none'}
                  strokeWidth={2}
                />
              </button>
            );
          })}
        </div>
      </div>
      {showDescriptions && description && (
        <div className="font-medium text-foreground text-sm">{description}</div>
      )}
    </div>
  );
}

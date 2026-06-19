/**
 * Score slider component for precise score input (0-100).
 *
 * Provides a visual slider interface for selecting scores with more granular
 * control than star rating. Supports mouse and touch interactions, color-coded
 * ranges, and label display.
 *
 * Features:
 * - Visual slider input
 * - Mouse and touch support
 * - Color-coded score ranges
 * - Score labels (Excellent, Good, Average, etc.)
 * - Value display
 * - Readonly mode
 * - Customizable min/max/step
 *
 * @param props - ScoreSlider component props
 * @returns Score slider element
 *
 * @example
 * ```tsx
 * <ScoreSlider
 *   value={70}
 *   onChange={(score) => setScore(score)}
 *   showLabels={true}
 * />
 * ```
 */
"use client";

import { cn } from "@feed/shared";
import { Minus, TrendingDown, TrendingUp } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

interface ScoreSliderProps {
  value?: number; // 0-100
  onChange?: (score: number) => void;
  min?: number;
  max?: number;
  step?: number;
  showValue?: boolean;
  showLabels?: boolean;
  readonly?: boolean;
  className?: string;
}

export function ScoreSlider({
  value = 50,
  onChange,
  min = 0,
  max = 100,
  step = 1,
  showValue = true,
  showLabels = true,
  readonly = false,
  className = "",
}: ScoreSliderProps) {
  const [isDragging, setIsDragging] = useState(false);
  const sliderRef = useRef<HTMLDivElement>(null);

  const clampedValue = Math.max(min, Math.min(max, value));
  const percentage = ((clampedValue - min) / (max - min)) * 100;

  const getColorClass = (score: number): string => {
    if (score >= 80) return "bg-green-500";
    if (score >= 60) return "bg-blue-500";
    if (score >= 40) return "bg-yellow-500";
    if (score >= 20) return "bg-orange-500";
    return "bg-red-500";
  };

  const getScoreLabel = (
    score: number,
  ): { label: string; Icon: typeof TrendingUp } => {
    if (score >= 80) return { label: "Excellent", Icon: TrendingUp };
    if (score >= 60) return { label: "Good", Icon: TrendingUp };
    if (score >= 40) return { label: "Average", Icon: Minus };
    if (score >= 20) return { label: "Below Average", Icon: TrendingDown };
    return { label: "Poor", Icon: TrendingDown };
  };

  const updateValue = useCallback(
    (clientX: number) => {
      if (!sliderRef.current || readonly || !onChange) return;

      const rect = sliderRef.current.getBoundingClientRect();
      const offsetX = clientX - rect.left;
      const percentage = Math.max(0, Math.min(1, offsetX / rect.width));
      const rawValue = min + percentage * (max - min);
      const steppedValue = Math.round(rawValue / step) * step;
      const newValue = Math.max(min, Math.min(max, steppedValue));

      onChange(newValue);
    },
    [readonly, onChange, min, max, step],
  );

  const handleMouseDown = (e: React.MouseEvent) => {
    if (readonly) return;
    setIsDragging(true);
    updateValue(e.clientX);
  };

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!isDragging) return;
      updateValue(e.clientX);
    },
    [isDragging, updateValue],
  );

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  useEffect(() => {
    if (isDragging) {
      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);

      return () => {
        window.removeEventListener("mousemove", handleMouseMove);
        window.removeEventListener("mouseup", handleMouseUp);
      };
    }
    return undefined;
  }, [isDragging, handleMouseMove, handleMouseUp]);

  const { label, Icon } = getScoreLabel(clampedValue);

  return (
    <div className={cn("space-y-3", className)}>
      {/* Value Display */}
      {showValue && (
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="font-bold text-2xl text-foreground">
              {clampedValue}
            </span>
            <span className="text-muted-foreground text-sm">/100</span>
          </div>
          {showLabels && (
            <div className="flex items-center gap-1 font-medium text-muted-foreground text-sm">
              <Icon className="h-4 w-4" />
              <span>{label}</span>
            </div>
          )}
        </div>
      )}

      {/* Slider Track */}
      <div
        ref={sliderRef}
        onMouseDown={handleMouseDown}
        className={cn(
          "relative h-3 overflow-hidden rounded-full bg-gray-700",
          !readonly && "cursor-pointer",
          isDragging && "cursor-grabbing",
        )}
      >
        {/* Filled Track */}
        <div
          className={cn(
            "absolute top-0 left-0 h-full transition-all",
            getColorClass(clampedValue),
            isDragging ? "duration-0" : "duration-200",
          )}
          style={{ width: `${percentage}%` }}
        />

        {/* Thumb */}
        {!readonly && (
          <div
            className={cn(
              "absolute top-1/2 h-5 w-5 -translate-y-1/2 rounded-full bg-white shadow-lg transition-transform",
              isDragging ? "scale-110 duration-0" : "duration-200",
              !readonly && "hover:scale-110",
            )}
            style={{ left: `calc(${percentage}% - 10px)` }}
          />
        )}
      </div>

      {/* Labels */}
      {showLabels && (
        <div className="flex justify-between text-muted-foreground text-xs">
          <span>{min}</span>
          <span>Average</span>
          <span>{max}</span>
        </div>
      )}
    </div>
  );
}

/**
 * ScoreSliderCompact Component
 *
 * Minimal slider without labels or value display
 */
interface ScoreSliderCompactProps {
  value: number;
  onChange?: (score: number) => void;
  readonly?: boolean;
  className?: string;
}

export function ScoreSliderCompact({
  value,
  onChange,
  readonly = false,
  className = "",
}: ScoreSliderCompactProps) {
  return (
    <ScoreSlider
      value={value}
      onChange={onChange}
      showValue={false}
      showLabels={false}
      readonly={readonly}
      className={className}
    />
  );
}

/**
 * PercentageSlider Component
 *
 * Slider formatted as percentage
 */
interface PercentageSliderProps {
  value: number; // 0-100
  onChange?: (value: number) => void;
  label?: string;
  readonly?: boolean;
  className?: string;
}

export function PercentageSlider({
  value,
  onChange,
  label,
  readonly = false,
  className = "",
}: PercentageSliderProps) {
  return (
    <div className={cn("space-y-2", className)}>
      {label && (
        <div className="flex items-center justify-between">
          <span className="font-medium text-foreground text-sm">{label}</span>
          <span className="font-bold text-foreground text-sm">{value}%</span>
        </div>
      )}
      <ScoreSlider
        value={value}
        onChange={onChange}
        min={0}
        max={100}
        step={1}
        showValue={false}
        showLabels={false}
        readonly={readonly}
      />
    </div>
  );
}

/**
 * Animated counter component for smooth number counting animations.
 * Used for displaying earnings, balances, and other numeric values with visual flair.
 */

"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "../../lib/utils";

interface AnimatedCounterProps {
  value: number;
  prefix?: string;
  suffix?: string;
  decimals?: number;
  duration?: number;
  className?: string;
  onComplete?: () => void;
}

export function AnimatedCounter({
  value,
  prefix = "",
  suffix = "",
  decimals = 2,
  duration = 1500,
  className,
  onComplete,
}: AnimatedCounterProps) {
  const [displayValue, setDisplayValue] = useState(0);
  const previousValue = useRef(0);
  const animationRef = useRef<number | null>(null);

  useEffect(() => {
    const startValue = previousValue.current;
    const endValue = value;
    const startTime = performance.now();

    const animate = (currentTime: number) => {
      const elapsed = currentTime - startTime;
      const progress = Math.min(elapsed / duration, 1);

      // Easing function (ease-out cubic)
      const easeOutCubic = 1 - (1 - progress) ** 3;

      const currentValue = startValue + (endValue - startValue) * easeOutCubic;
      setDisplayValue(currentValue);

      if (progress < 1) {
        animationRef.current = requestAnimationFrame(animate);
      } else {
        previousValue.current = endValue;
        onComplete?.();
      }
    };

    animationRef.current = requestAnimationFrame(animate);

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [value, duration, onComplete]);

  const formattedValue = displayValue.toFixed(decimals);

  return (
    <span className={cn("tabular-nums font-mono transition-opacity duration-300", className)}>
      {prefix}
      {formattedValue}
      {suffix}
    </span>
  );
}

interface AnimatedCounterWithLabelProps extends AnimatedCounterProps {
  label: string;
  labelClassName?: string;
  valueClassName?: string;
  trend?: {
    value: number;
    period: string;
  };
}

export function AnimatedCounterWithLabel({
  label,
  labelClassName,
  valueClassName,
  trend,
  ...counterProps
}: AnimatedCounterWithLabelProps) {
  return (
    <div className="flex flex-col">
      <span className={cn("text-xs text-neutral-500 mb-1", labelClassName)}>{label}</span>
      <AnimatedCounter
        {...counterProps}
        className={cn("text-xl font-semibold text-white", valueClassName)}
      />
      {trend && (
        <span
          className={cn(
            "text-xs mt-1 flex items-center gap-1",
            trend.value >= 0 ? "text-emerald-400" : "text-red-400",
          )}
        >
          <span>{trend.value >= 0 ? "↑" : "↓"}</span>
          <span>${Math.abs(trend.value).toFixed(2)}</span>
          <span className="text-neutral-500">{trend.period}</span>
        </span>
      )}
    </div>
  );
}

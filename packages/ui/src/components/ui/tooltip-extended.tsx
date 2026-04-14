import { X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Z_OVERLAY, Z_TOOLTIP } from "../../lib/floating-layers";
import { cn } from "../../lib/utils";
import { Button } from "./button";

export interface HoverTooltipProps {
  children: React.ReactNode;
  content: React.ReactNode;
  position?: "top" | "bottom" | "left" | "right";
  delay?: number;
  showArrow?: boolean;
  className?: string;
  visible?: boolean;
  onDismiss?: () => void;
}

export function HoverTooltip({
  children,
  content,
  position = "top",
  delay = 300,
  showArrow = true,
  className = "",
  visible: controlledVisible,
  onDismiss,
}: HoverTooltipProps) {
  const [isVisible, setIsVisible] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const isVisibleState =
    controlledVisible !== undefined ? controlledVisible : isVisible;

  const show = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => setIsVisible(true), delay);
  }, [delay]);

  const hide = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => setIsVisible(false), 150);
  }, []);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: this wrapper centralizes hover/focus handling for arbitrary child content.
    <div
      ref={containerRef}
      className="relative inline-flex cursor-default"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}

      {isVisibleState && (
        <div
          className={cn(
            "absolute z-50",
            position === "top"
              ? "bottom-full left-1/2 -translate-x-1/2 mb-2"
              : position === "bottom"
                ? "top-full left-1/2 -translate-x-1/2 mt-2"
                : position === "left"
                  ? "right-full top-1/2 -translate-y-1/2 mr-2"
                  : "left-full top-1/2 -translate-y-1/2 ml-2",
            className,
          )}
        >
          <div className="relative bg-bg-elevated border border-border rounded-lg shadow-xl p-3 min-w-[10rem] max-w-xs">
            {onDismiss && (
              <Button
                variant="ghost"
                size="icon"
                onClick={onDismiss}
                className="absolute top-1 right-1 h-6 w-6 text-muted hover:text-txt rounded"
                aria-label="Dismiss tooltip"
              >
                <X className="w-3 h-3" />
              </Button>
            )}
            {content}

            {showArrow && (
              <div
                className={cn(
                  "absolute w-0 h-0 border-4",
                  position === "top"
                    ? "top-full left-1/2 -translate-x-1/2 border-t-border border-l-transparent border-r-transparent border-b-transparent"
                    : position === "bottom"
                      ? "bottom-full left-1/2 -translate-x-1/2 border-b-border border-l-transparent border-r-transparent border-t-transparent"
                      : position === "left"
                        ? "left-full top-1/2 -translate-y-1/2 border-l-border border-t-transparent border-b-transparent border-r-transparent"
                        : "right-full top-1/2 -translate-y-1/2 border-r-border border-t-transparent border-b-transparent border-l-transparent",
                )}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function IconTooltip({
  children,
  label,
  shortcut,
  position = "top",
  multiline = false,
}: {
  children: React.ReactNode;
  label: string;
  shortcut?: string;
  position?: "top" | "bottom";
  /** Long labels: wrap and cap width. */
  multiline?: boolean;
}) {
  return (
    <div className="relative isolate group">
      {children}
      <div
        className={cn(
          `absolute px-3 py-2 bg-bg-elevated border border-border text-xs text-txt-strong rounded-lg opacity-0 invisible group-hover:opacity-100 group-hover:visible group-focus-within:opacity-100 group-focus-within:visible transition-opacity duration-200 z-[${Z_OVERLAY}] shadow-lg pointer-events-none`,
          position === "top"
            ? "bottom-full left-1/2 -translate-x-1/2 mb-2"
            : "top-full left-1/2 -translate-x-1/2 mt-2",
          multiline
            ? "min-w-[10rem] max-w-[min(22rem,calc(100vw-1.5rem))] whitespace-normal text-left leading-snug"
            : "min-w-[6rem] whitespace-nowrap",
        )}
        role="tooltip"
      >
        <div className="font-medium">{label}</div>
        {shortcut && <div className="text-muted mt-0.5">{shortcut}</div>}
        <div
          className={
            position === "top"
              ? "absolute top-full left-1/2 -translate-x-1/2 -mt-1 border-4 border-transparent border-t-bg-elevated"
              : "absolute bottom-full left-1/2 -translate-x-1/2 -mb-1 border-4 border-transparent border-b-bg-elevated"
          }
        />
      </div>
    </div>
  );
}

export interface SpotlightProps {
  target: string;
  title: string;
  description: string;
  step: number;
  totalSteps: number;
  onNext: () => void;
  onPrev: () => void;
  onSkip: () => void;
  /** Labels to override defaults. */
  labels?: {
    stepOf?: string;
    skipTour?: string;
    previous?: string;
    finish?: string;
    next?: string;
  };
}

export function Spotlight({
  target,
  title,
  description,
  step,
  totalSteps,
  onNext,
  onPrev,
  onSkip,
  labels = {},
}: SpotlightProps) {
  const [targetRect, setTargetRect] = useState<DOMRect | null>(null);

  useEffect(() => {
    const element = document.querySelector(target);
    if (element) {
      const rect = element.getBoundingClientRect();
      setTargetRect(rect);
    }
  }, [target]);

  if (!targetRect) return null;

  const padding = 8;

  return (
    <div className={`fixed inset-0 z-[${Z_TOOLTIP}] pointer-events-none`}>
      <div
        className="absolute inset-0 bg-black/60 pointer-events-auto"
        style={{
          clipPath: `polygon(
            0% 0%,
            0% 100%,
            ${targetRect.left - padding}px 100%,
            ${targetRect.left - padding}px ${targetRect.top - padding}px,
            ${targetRect.right + padding}px ${targetRect.top - padding}px,
            ${targetRect.right + padding}px ${targetRect.bottom + padding}px,
            ${targetRect.left - padding}px ${targetRect.bottom + padding}px,
            ${targetRect.left - padding}px 100%,
            100% 100%,
            100% 0%
          )`,
        }}
      />

      <div
        className="absolute bg-card border border-border rounded-xl shadow-2xl p-5 max-w-sm pointer-events-auto"
        style={{
          top: targetRect.bottom + padding + 16,
          left: Math.min(targetRect.left, window.innerWidth - 340),
        }}
      >
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs text-muted font-medium">
            {labels.stepOf ?? "Step"} {step} of {totalSteps}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={onSkip}
            className="h-auto px-1 py-0 text-xs text-muted hover:text-txt"
          >
            {labels.skipTour ?? "Skip Tour"}
          </Button>
        </div>

        <h3 className="text-lg font-bold text-txt-strong mb-2">{title}</h3>
        <p className="text-sm text-muted mb-4">{description}</p>

        <div className="flex items-center justify-between">
          <Button variant="outline" onClick={onPrev} disabled={step === 1}>
            {labels.previous ?? "Previous"}
          </Button>

          <div className="flex gap-1">
            {Array.from({ length: totalSteps }, (_, idx) => idx).map(
              (dotIndex) => (
                <div
                  key={`step-dot-${dotIndex}`}
                  className={`w-2 h-2 rounded-full transition-colors ${
                    dotIndex + 1 === step ? "bg-accent" : "bg-border"
                  }`}
                />
              ),
            )}
          </div>

          <Button onClick={onNext}>
            {step === totalSteps
              ? (labels.finish ?? "Finish")
              : (labels.next ?? "Next")}
          </Button>
        </div>
      </div>
    </div>
  );
}

export interface TourStep {
  target: string;
  title: string;
  description: string;
}

export function useGuidedTour(steps: TourStep[]) {
  const [isActive, setIsActive] = useState(false);
  const [currentStep, setCurrentStep] = useState(0);

  const start = useCallback(() => {
    setIsActive(true);
    setCurrentStep(0);
  }, []);

  const next = useCallback(() => {
    if (currentStep < steps.length - 1) {
      setCurrentStep((prev) => prev + 1);
    } else {
      setIsActive(false);
    }
  }, [currentStep, steps.length]);

  const prev = useCallback(() => {
    setCurrentStep((prev) => Math.max(0, prev - 1));
  }, []);

  const skip = useCallback(() => {
    setIsActive(false);
  }, []);

  return {
    isActive,
    currentStep,
    step: steps[currentStep],
    start,
    next,
    prev,
    skip,
    totalSteps: steps.length,
  };
}

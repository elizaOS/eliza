/**
 * OnboardingOverlay - Renders the spotlight highlight and tooltip for onboarding.
 * Uses CSS clip-path to create a "spotlight" effect on the target element.
 */

"use client";

import { Button } from "@elizaos/ui";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { TooltipPlacement } from "@/lib/onboarding/types";
import { cn } from "@/lib/utils";
import { useOnboarding } from "./onboarding-provider";

interface TargetRect {
  top: number;
  left: number;
  width: number;
  height: number;
  bottom: number;
  right: number;
}

const PADDING = 8;
const TOOLTIP_OFFSET = 16;

function getTooltipPosition(
  targetRect: TargetRect,
  placement: TooltipPlacement,
  tooltipWidth: number,
  tooltipHeight: number,
): { top: number; left: number } {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  let top = 0;
  let left = 0;

  switch (placement) {
    case "top":
      top = targetRect.top - tooltipHeight - TOOLTIP_OFFSET;
      left = targetRect.left + targetRect.width / 2 - tooltipWidth / 2;
      break;
    case "bottom":
      top = targetRect.bottom + TOOLTIP_OFFSET;
      left = targetRect.left + targetRect.width / 2 - tooltipWidth / 2;
      break;
    case "left":
      top = targetRect.top + targetRect.height / 2 - tooltipHeight / 2;
      left = targetRect.left - tooltipWidth - TOOLTIP_OFFSET;
      break;
    case "right":
      top = targetRect.top + targetRect.height / 2 - tooltipHeight / 2;
      left = targetRect.right + TOOLTIP_OFFSET;
      break;
  }

  // Clamp to viewport bounds
  top = Math.max(16, Math.min(top, viewportHeight - tooltipHeight - 16));
  left = Math.max(16, Math.min(left, viewportWidth - tooltipWidth - 16));

  return { top, left };
}

export function OnboardingOverlay() {
  const {
    activeTour,
    currentStepIndex,
    isActive,
    nextStep,
    prevStep,
    skipTour,
  } = useOnboarding();

  const [targetRect, setTargetRect] = useState<TargetRect | null>(null);
  const [tooltipSize, setTooltipSize] = useState({ width: 320, height: 200 });
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [mounted, _setMounted] = useState(() => typeof window !== "undefined");

  const currentStep = activeTour?.steps[currentStepIndex];

  // Find and measure target element
  const updateTargetRect = useCallback(() => {
    if (!currentStep) {
      setTargetRect(null);
      return;
    }

    const element = document.querySelector(currentStep.target);
    if (!element) {
      console.warn(
        `[Onboarding] Target element not found: ${currentStep.target}`,
      );
      setTargetRect(null);
      return;
    }

    const rect = element.getBoundingClientRect();
    setTargetRect({
      top: rect.top - PADDING,
      left: rect.left - PADDING,
      width: rect.width + PADDING * 2,
      height: rect.height + PADDING * 2,
      bottom: rect.bottom + PADDING,
      right: rect.right + PADDING,
    });
  }, [currentStep]);

  // Update target rect on step change and resize
  useEffect(() => {
    if (!isActive) return;

    // Use requestAnimationFrame to defer state update outside of effect body
    const rafId = requestAnimationFrame(() => {
      updateTargetRect();
    });

    // Delay to ensure DOM is fully rendered
    const timer = setTimeout(updateTargetRect, 100);

    window.addEventListener("resize", updateTargetRect);
    window.addEventListener("scroll", updateTargetRect, true);

    return () => {
      cancelAnimationFrame(rafId);
      clearTimeout(timer);
      window.removeEventListener("resize", updateTargetRect);
      window.removeEventListener("scroll", updateTargetRect, true);
    };
  }, [isActive, updateTargetRect]);

  // Measure tooltip size
  useEffect(() => {
    if (tooltipRef.current) {
      const rect = tooltipRef.current.getBoundingClientRect();
      setTooltipSize({ width: rect.width, height: rect.height });
    }
  }, []);

  if (!mounted || !isActive || !currentStep || !activeTour) {
    return null;
  }

  const totalSteps = activeTour.steps.length;
  const isFirstStep = currentStepIndex === 0;
  const isLastStep = currentStepIndex === totalSteps - 1;

  // Calculate clip-path for spotlight effect
  const clipPath = targetRect
    ? `polygon(
        0% 0%,
        0% 100%,
        ${targetRect.left}px 100%,
        ${targetRect.left}px ${targetRect.top}px,
        ${targetRect.right}px ${targetRect.top}px,
        ${targetRect.right}px ${targetRect.bottom}px,
        ${targetRect.left}px ${targetRect.bottom}px,
        ${targetRect.left}px 100%,
        100% 100%,
        100% 0%
      )`
    : "none";

  const tooltipPosition = targetRect
    ? getTooltipPosition(
        targetRect,
        currentStep.placement,
        tooltipSize.width,
        tooltipSize.height,
      )
    : { top: 0, left: 0 };

  return createPortal(
    <div className="fixed inset-0 z-[9999] pointer-events-none">
      {/* Backdrop with spotlight cutout */}
      <button
        type="button"
        aria-label="Skip tour"
        className="absolute inset-0 bg-black/70 pointer-events-auto transition-all duration-300 cursor-default"
        style={{ clipPath }}
        onClick={skipTour}
        onKeyDown={(e) => e.key === "Escape" && skipTour()}
      />

      {/* Visual-only highlight ring. Pointer events pass through so the
          user can still interact with the highlighted CTA — clicking the
          underlying element naturally advances them to that surface, and
          the tooltip's Next button advances the tour itself. The previous
          implementation rendered an opaque button on top of the CTA that
          blocked the very action the tour was pointing at. */}
      {targetRect && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute rounded-lg border border-accent/40 ring-1 ring-accent/20 transition-all duration-300"
          style={{
            top: targetRect.top - 2,
            left: targetRect.left - 2,
            width: targetRect.width + 4,
            height: targetRect.height + 4,
          }}
        />
      )}

      {/* Tooltip */}
      {targetRect && (
        <div
          ref={tooltipRef}
          className="pointer-events-auto absolute w-80 rounded-lg border border-border bg-card shadow-2xl transition-all duration-300"
          style={{
            top: tooltipPosition.top,
            left: tooltipPosition.left,
          }}
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-border p-4">
            <div className="flex items-center gap-2">
              <span className="inline-block h-2 w-2 rounded-full bg-accent" />
              <h3 className="font-medium text-txt">{currentStep.title}</h3>
            </div>
            <button
              type="button"
              onClick={skipTour}
              className="text-muted transition-colors hover:text-txt"
              aria-label="Skip tour"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Content */}
          <div className="p-4">
            <p className="text-sm leading-relaxed text-muted-strong">
              {currentStep.description}
            </p>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between border-t border-border p-4">
            {/* Progress indicator */}
            <div className="flex items-center gap-1.5">
              {Array.from({ length: totalSteps }, (_, i) => i).map(
                (stepIndex) => (
                  <div
                    key={`step-dot-${stepIndex}`}
                    className={cn(
                      "h-2 w-2 rounded-full transition-colors",
                      stepIndex === currentStepIndex
                        ? "bg-accent"
                        : "bg-muted/30",
                    )}
                  />
                ),
              )}
              <span className="ml-2 text-xs text-muted">
                {currentStepIndex + 1} of {totalSteps}
              </span>
            </div>

            {/* Navigation buttons */}
            <div className="flex items-center gap-2">
              {!isFirstStep && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={prevStep}
                  className="text-muted hover:bg-surface hover:text-txt"
                >
                  <ChevronLeft className="h-4 w-4 mr-1" />
                  Back
                </Button>
              )}
              <Button
                size="sm"
                onClick={nextStep}
                className="bg-accent text-accent-fg hover:bg-accent/90"
              >
                {isLastStep ? "Done" : "Next"}
                {!isLastStep && <ChevronRight className="h-4 w-4 ml-1" />}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}

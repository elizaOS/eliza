/**
 * OnboardingOverlay - Renders the spotlight highlight and tooltip for onboarding.
 * Uses CSS clip-path to create a "spotlight" effect on the target element.
 */

"use client";

import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { TooltipPlacement } from "@/lib/onboarding/types";
import { cn } from "@/lib/utils";
import { Button } from "@elizaos/cloud-ui/components/button";
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
  const { activeTour, currentStepIndex, isActive, nextStep, prevStep, skipTour } = useOnboarding();

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
      console.warn(`[Onboarding] Target element not found: ${currentStep.target}`);
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
    ? getTooltipPosition(targetRect, currentStep.placement, tooltipSize.width, tooltipSize.height)
    : { top: 0, left: 0 };

  return createPortal(
    <div className="fixed inset-0 z-[9999] pointer-events-none">
      {/* Backdrop with spotlight cutout */}
      <div
        className="absolute inset-0 bg-black/70 pointer-events-auto transition-all duration-300"
        style={{ clipPath }}
        onClick={skipTour}
      />

      {/* Clickable highlight area - clicking advances the tour */}
      {targetRect && (
        <div
          className="absolute border-2 border-[#FF5800] rounded-lg pointer-events-auto cursor-pointer transition-all duration-300 hover:bg-white/5"
          style={{
            top: targetRect.top,
            left: targetRect.left,
            width: targetRect.width,
            height: targetRect.height,
          }}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            nextStep();
          }}
          title="Click to continue"
        />
      )}

      {/* Tooltip */}
      {targetRect && (
        <div
          ref={tooltipRef}
          className="absolute w-80 bg-[#1A1A1A] border border-[#353535] rounded-lg shadow-2xl pointer-events-auto transition-all duration-300"
          style={{
            top: tooltipPosition.top,
            left: tooltipPosition.left,
          }}
        >
          {/* Header */}
          <div className="flex items-center justify-between p-4 border-b border-[#353535]">
            <div className="flex items-center gap-2">
              <span className="inline-block w-2 h-2 rounded-full bg-[#FF5800]" />
              <h3 className="text-white font-medium">{currentStep.title}</h3>
            </div>
            <button
              onClick={skipTour}
              className="text-white/60 hover:text-white transition-colors"
              aria-label="Skip tour"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Content */}
          <div className="p-4">
            <p className="text-white/80 text-sm leading-relaxed">{currentStep.description}</p>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between p-4 border-t border-[#353535]">
            {/* Progress indicator */}
            <div className="flex items-center gap-1.5">
              {Array.from({ length: totalSteps }).map((_, i) => (
                <div
                  key={i}
                  className={cn(
                    "w-2 h-2 rounded-full transition-colors",
                    i === currentStepIndex ? "bg-[#FF5800]" : "bg-white/20",
                  )}
                />
              ))}
              <span className="ml-2 text-xs text-white/40">
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
                  className="text-white/60 hover:text-white hover:bg-white/10"
                >
                  <ChevronLeft className="h-4 w-4 mr-1" />
                  Back
                </Button>
              )}
              <Button
                size="sm"
                onClick={nextStep}
                className="bg-[#FF5800] hover:bg-[#FF5800]/90 text-white"
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

"use client";

import { motion } from "framer-motion";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
export interface TutorialStep {
  target: string;
  title: string;
  description: string;
  placement: "top" | "bottom" | "left" | "right";
}

export interface TutorialState {
  isActive: boolean;
  currentStep: number;
  steps: TutorialStep[];
  hasCompleted: boolean;
  next: () => void;
  prev: () => void;
  dismiss: () => void;
  complete: () => void;
  restart: () => void;
}

const SPOTLIGHT_PADDING = 8;
const TOOLTIP_GAP = 12;
const VIEWPORT_MARGIN = 12;
const TARGET_POLL_INTERVAL = 100;
const TARGET_POLL_MAX = 2000;

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export function getSpotlightActivationState(params: {
  hasStep: boolean;
  isActive: boolean;
  wasActive: boolean;
}) {
  if (!params.isActive || !params.hasStep) {
    return { justActivated: false, nextWasActive: false };
  }

  if (params.wasActive) {
    return { justActivated: false, nextWasActive: true };
  }

  return { justActivated: true, nextWasActive: true };
}

/** Compute a padded rect for the target, unioning any data-tour-include elements. */
function computeTargetRect(selector: string): Rect | null {
  const el = document.querySelector(selector);
  if (!el) return null;

  // Extract the tour name from the selector, e.g. '[data-tour="market-dropdown"]' → 'market-dropdown'
  const tourName = selector.match(/data-tour="([^"]+)"/)?.[1];
  const rects = [el.getBoundingClientRect()];

  if (tourName) {
    const extras = Array.from(
      document.querySelectorAll(`[data-tour-include="${tourName}"]`),
    );
    // Note: Array.from ensures safe iteration over NodeList, avoiding TypeScript issues.
    for (const extra of Array.from(extras)) {
      rects.push(extra.getBoundingClientRect());
    }
  }

  let top = Infinity;
  let left = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const r of rects) {
    top = Math.min(top, r.top);
    left = Math.min(left, r.left);
    right = Math.max(right, r.right);
    bottom = Math.max(bottom, r.bottom);
  }

  return {
    top: top - SPOTLIGHT_PADDING,
    left: left - SPOTLIGHT_PADDING,
    width: right - left + SPOTLIGHT_PADDING * 2,
    height: bottom - top + SPOTLIGHT_PADDING * 2,
  };
}

type SpotlightTutorialProps = Pick<
  TutorialState,
  "isActive" | "currentStep" | "steps" | "next" | "prev" | "dismiss"
>;

export function SpotlightTutorial({
  isActive,
  currentStep,
  steps,
  next,
  prev,
  dismiss,
}: SpotlightTutorialProps) {
  const [dynamicRect, setDynamicRect] = useState<Rect | null>(null);
  const [mounted, setMounted] = useState(false);
  const [tooltipReady, setTooltipReady] = useState(false);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const wasActiveRef = useRef(false);
  const justActivatedRef = useRef(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const step: TutorialStep | undefined = steps[currentStep];
  const isLastStep = currentStep === steps.length - 1;
  const isFirstStep = currentStep === 0;

  // Sync the initial spotlight rect after activation without mutating state during render.
  // Step-to-step transitions keep using the delayed recomputation below for smoother motion.
  useLayoutEffect(() => {
    const activation = getSpotlightActivationState({
      hasStep: Boolean(step),
      isActive,
      wasActive: wasActiveRef.current,
    });

    wasActiveRef.current = activation.nextWasActive;
    justActivatedRef.current = activation.justActivated;

    if (!activation.justActivated || !step) {
      return;
    }

    const rect = computeTargetRect(step.target);
    if (rect) {
      setDynamicRect(rect);
    }
  }, [isActive, step]);

  const updateRect = useCallback(() => {
    if (!step) return;
    const rect = computeTargetRect(step.target);
    if (rect) setDynamicRect(rect);
  }, [step]);

  // Poll for target if not found on initial render
  useEffect(() => {
    if (!isActive || !step) return;

    const el = document.querySelector(step.target);
    if (el) return; // Already found synchronously

    let pollCount = 0;
    const pollInterval = setInterval(() => {
      const found = document.querySelector(step.target);
      if (found) {
        updateRect();
        clearInterval(pollInterval);
      } else {
        pollCount += TARGET_POLL_INTERVAL;
        if (pollCount >= TARGET_POLL_MAX) {
          clearInterval(pollInterval);
          next();
        }
      }
    }, TARGET_POLL_INTERVAL);

    return () => clearInterval(pollInterval);
  }, [isActive, step, updateRect, next]);

  // Recompute after a short delay to catch async elements (e.g. dropdown opening via effect)
  // Then show tooltip after spotlight transition settles
  useEffect(() => {
    if (!isActive || !step) return;

    const justActivated = justActivatedRef.current;
    justActivatedRef.current = false;

    if (!justActivated) {
      setTooltipReady(false);
    }

    const rectTimer = setTimeout(updateRect, 200);
    const tooltipTimer = setTimeout(
      () => setTooltipReady(true),
      justActivated ? 0 : 350,
    );
    return () => {
      clearTimeout(rectTimer);
      clearTimeout(tooltipTimer);
    };
  }, [isActive, step, updateRect]);

  // ResizeObserver + scroll/resize listeners for dynamic updates
  useEffect(() => {
    if (!isActive || !step) return;

    const el = document.querySelector(step.target);
    if (!el) return;

    const ro = new ResizeObserver(updateRect);
    ro.observe(el);

    window.addEventListener("resize", updateRect);
    window.addEventListener("scroll", updateRect, true);

    return () => {
      ro.disconnect();
      window.removeEventListener("resize", updateRect);
      window.removeEventListener("scroll", updateRect, true);
    };
  }, [isActive, step, updateRect]);

  if (!mounted || !isActive || !step || !dynamicRect) return null;

  return createPortal(
    <div className="fixed inset-0" style={{ zIndex: 90 }}>
      {/* Dark backdrop with transparent hole — transitions between steps only */}
      <div
        className="absolute transition-all duration-300 ease-out"
        style={{
          top: dynamicRect.top,
          left: dynamicRect.left,
          width: dynamicRect.width,
          height: dynamicRect.height,
          borderRadius: 0,
          boxShadow:
            "0 0 0 9999px rgba(0, 0, 0, 0.6), 0 0 30px 8px rgba(255, 255, 255, 0.2)",
        }}
      />
      {/* Brightness boost over the spotlighted area */}
      <div
        className="pointer-events-none absolute transition-all duration-300 ease-out"
        style={{
          top: dynamicRect.top,
          left: dynamicRect.left,
          width: dynamicRect.width,
          height: dynamicRect.height,
          borderRadius: 0,
          backgroundColor: "rgba(255, 255, 255, 0.1)",
        }}
      />

      {/* Tooltip — shown after spotlight transition settles */}
      {tooltipReady && (
        <Tooltip
          ref={tooltipRef}
          step={step}
          dynamicRect={dynamicRect}
          currentStep={currentStep}
          totalSteps={steps.length}
          isFirstStep={isFirstStep}
          isLastStep={isLastStep}
          onNext={next}
          onPrev={prev}
          onDismiss={dismiss}
        />
      )}
    </div>,
    document.body,
  );
}

interface TooltipProps {
  step: TutorialStep;
  dynamicRect: Rect;
  currentStep: number;
  totalSteps: number;
  isFirstStep: boolean;
  isLastStep: boolean;
  onNext: () => void;
  onPrev: () => void;
  onDismiss: () => void;
}

const Tooltip = ({
  ref,
  step,
  dynamicRect,
  currentStep,
  totalSteps,
  isFirstStep,
  isLastStep,
  onNext,
  onPrev,
  onDismiss,
}: TooltipProps & { ref: React.Ref<HTMLDivElement> }) => {
  const [tooltipSize, setTooltipSize] = useState({ width: 0, height: 0 });
  const internalRef = useRef<HTMLDivElement>(null);

  // Merge refs
  useEffect(() => {
    if (!ref) return;
    if (typeof ref === "function") {
      ref(internalRef.current);
    } else {
      (ref as React.MutableRefObject<HTMLDivElement | null>).current =
        internalRef.current;
    }
  }, [ref]);

  // Measure tooltip on mount (component remounts via key on step change)
  useLayoutEffect(() => {
    if (internalRef.current) {
      const r = internalRef.current.getBoundingClientRect();
      setTooltipSize({ width: r.width, height: r.height });
    }
  }, []);

  const position = computeTooltipPosition(
    step.placement,
    dynamicRect,
    tooltipSize,
  );

  return (
    <motion.div
      ref={internalRef}
      key={`tooltip-${currentStep}`}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.2, delay: 0.1 }}
      className="fixed w-72 rounded-xl border border-border bg-card p-4 shadow-2xl"
      style={{
        top: position.top,
        left: position.left,
        zIndex: 91,
      }}
    >
      {/* Close button */}
      <button
        type="button"
        onClick={onDismiss}
        className="absolute top-2 right-2 p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        aria-label="Close tutorial"
      >
        <X size={14} />
      </button>

      {/* Step counter */}
      <div className="mb-1 font-mono text-card-foreground/80 text-xs">
        {currentStep + 1} / {totalSteps}
      </div>

      {/* Title */}
      <h3 className="mb-1.5 font-bold text-foreground text-sm">{step.title}</h3>

      {/* Description */}
      <p className="mb-4 text-card-foreground/70 text-xs leading-relaxed">
        {step.description}
      </p>

      {/* Navigation buttons */}
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={onPrev}
          disabled={isFirstStep}
          className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 font-medium text-muted-foreground text-xs transition-colors hover:text-foreground disabled:invisible"
        >
          <ChevronLeft size={12} />
          Back
        </button>

        <button
          type="button"
          onClick={onNext}
          className="inline-flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 font-semibold text-primary-foreground text-xs transition-colors hover:bg-primary/90"
        >
          {isLastStep ? "Done" : "Next"}
          {!isLastStep && <ChevronRight size={12} />}
        </button>
      </div>
    </motion.div>
  );
};

function computeTooltipPosition(
  placement: TutorialStep["placement"],
  spotlight: Rect,
  tooltip: { width: number; height: number },
): { top: number; left: number } {
  let top = 0;
  let left = 0;

  switch (placement) {
    case "bottom":
      top = spotlight.top + spotlight.height + TOOLTIP_GAP;
      left = spotlight.left + spotlight.width / 2 - tooltip.width / 2;
      break;
    case "top":
      top = spotlight.top - tooltip.height - TOOLTIP_GAP;
      left = spotlight.left + spotlight.width / 2 - tooltip.width / 2;
      break;
    case "left":
      top = spotlight.top + spotlight.height / 2 - tooltip.height / 2;
      left = spotlight.left - tooltip.width - TOOLTIP_GAP;
      break;
    case "right":
      top = spotlight.top + spotlight.height / 2 - tooltip.height / 2;
      left = spotlight.left + spotlight.width + TOOLTIP_GAP;
      break;
  }

  // Clamp to viewport
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  left = Math.max(
    VIEWPORT_MARGIN,
    Math.min(left, vw - tooltip.width - VIEWPORT_MARGIN),
  );
  top = Math.max(
    VIEWPORT_MARGIN,
    Math.min(top, vh - tooltip.height - VIEWPORT_MARGIN),
  );

  return { top, left };
}

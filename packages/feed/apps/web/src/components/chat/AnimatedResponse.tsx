"use client";

import * as React from "react";
import { Response } from "./Response";

interface AnimatedResponseProps {
  children: string;
  className?: string;
  /** Whether to animate the text reveal */
  shouldAnimate?: boolean;
  /** Unique ID for the message (triggers re-animation when changed) */
  messageId?: string;
  /** Maximum duration for the animation in ms */
  maxDurationMs?: number;
  /** Callback when text is updated during animation (useful for auto-scroll) */
  onTextUpdate?: () => void;
}

/**
 * Animated markdown response with typing effect
 *
 * Wraps the Response component with a progressive text reveal animation.
 * Only animates when shouldAnimate is true (typically for recent messages).
 */
export const AnimatedResponse: React.FC<AnimatedResponseProps> = ({
  children,
  className,
  shouldAnimate = false,
  messageId,
  maxDurationMs = 10000,
  onTextUpdate,
}) => {
  const [visibleText, setVisibleText] = React.useState(
    shouldAnimate ? "" : children,
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: messageId is intentionally included to reset animation on new messages
  React.useEffect(() => {
    if (!shouldAnimate || !children.trim()) {
      setVisibleText(children);
      return;
    }

    const safeDuration = Math.max(1000, maxDurationMs);

    setVisibleText("");

    const TYPING_INTERVAL = 20;
    const totalChars = children.length;
    const totalSteps = Math.ceil(safeDuration / TYPING_INTERVAL);
    const charsPerStep = Math.max(1, Math.ceil(totalChars / totalSteps));

    let visibleCharCount = 0;
    const interval = setInterval(() => {
      visibleCharCount += charsPerStep;
      if (visibleCharCount >= totalChars) {
        setVisibleText(children);
        clearInterval(interval);
      } else {
        setVisibleText(children.slice(0, visibleCharCount));
      }
      // Notify parent that text was updated so it can handle scrolling
      onTextUpdate?.();
    }, TYPING_INTERVAL);

    return () => clearInterval(interval);
  }, [children, shouldAnimate, messageId, maxDurationMs, onTextUpdate]);

  return <Response className={className}>{visibleText}</Response>;
};

AnimatedResponse.displayName = "AnimatedResponse";

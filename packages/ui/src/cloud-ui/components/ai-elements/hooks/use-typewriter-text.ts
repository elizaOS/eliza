"use client";

import { useEffect, useRef, useState } from "react";

interface TypewriterConfig {
  charsPerFrame?: number;
  frameDelay?: number;
  onReveal?: () => void;
}

function useTypewriter(
  targetText: string,
  isActive: boolean,
  { charsPerFrame = 6, frameDelay = 10, onReveal }: TypewriterConfig = {},
) {
  const animState = useRef({
    visibleLength: 0,
    lastFrame: 0,
    animationId: null as number | null,
    lastTargetLength: 0,
    everActive: false,
  });
  const [displayLength, setDisplayLength] = useState(0);
  const onRevealRef = useRef(onReveal);

  useEffect(() => {
    onRevealRef.current = onReveal;
  });

  useEffect(() => {
    const state = animState.current;

    if (isActive && targetText) {
      state.everActive = true;
    }

    if (!targetText || targetText.length < state.lastTargetLength) {
      state.visibleLength = 0;
      state.lastTargetLength = targetText.length;
      setDisplayLength(0);
      if (!targetText) {
        state.everActive = false;
      }
      return;
    }

    state.lastTargetLength = targetText.length;

    if (!isActive && !state.everActive) {
      return;
    }

    if (state.visibleLength >= targetText.length && targetText.length > 0) {
      return;
    }

    const animate = (timestamp: number) => {
      if (timestamp - state.lastFrame < frameDelay) {
        state.animationId = requestAnimationFrame(animate);
        return;
      }

      state.lastFrame = timestamp;

      const remaining = targetText.length - state.visibleLength;
      if (remaining <= 0) {
        state.animationId = null;
        return;
      }

      state.visibleLength += Math.min(charsPerFrame, remaining);
      setDisplayLength(state.visibleLength);
      onRevealRef.current?.();

      if (state.visibleLength < targetText.length) {
        state.animationId = requestAnimationFrame(animate);
      } else {
        state.animationId = null;
      }
    };

    if (!state.animationId && targetText.length > state.visibleLength) {
      state.animationId = requestAnimationFrame(animate);
    }

    const currentState = animState.current;
    return () => {
      if (currentState.animationId) {
        cancelAnimationFrame(currentState.animationId);
        currentState.animationId = null;
      }
    };
  }, [charsPerFrame, frameDelay, isActive, targetText]);

  if (!targetText) return "";
  if (displayLength > 0 || isActive) return targetText.slice(0, displayLength);
  return targetText;
}

export function useTypewriterText(
  targetText: string,
  isActive: boolean,
  config: Pick<TypewriterConfig, "onReveal"> = {},
) {
  return useTypewriter(targetText, isActive, {
    charsPerFrame: 6,
    frameDelay: 10,
    onReveal: config.onReveal,
  });
}

export function useReasoningTypewriter(
  targetText: string,
  isActive: boolean,
  onReveal?: () => void,
) {
  return useTypewriter(targetText, isActive, {
    charsPerFrame: 4,
    frameDelay: 12,
    onReveal,
  });
}

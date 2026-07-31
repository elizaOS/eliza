/**
 * React visibility and idle gate for expensive browser-only render surfaces.
 */
import { type RefObject, useEffect, useRef, useState } from "react";
import { scheduleWhenIdle } from "@/lib/deferred-render";

interface DeferredRender {
  ready: boolean;
  targetRef: RefObject<HTMLDivElement | null>;
}

export function useDeferredRender(): DeferredRender {
  const targetRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (ready) return;

    let cancelIdle: (() => void) | null = null;
    let observer: IntersectionObserver | null = null;
    let visible = false;

    const renderNow = () => {
      cancelIdle?.();
      cancelIdle = null;
      observer?.disconnect();
      setReady(true);
    };

    const schedule = () => {
      if (!visible || document.visibilityState !== "visible" || cancelIdle) {
        return;
      }
      cancelIdle = scheduleWhenIdle(renderNow, window);
    };

    const onVisibilityChange = () => schedule();
    const onInteraction = () => {
      if (visible) renderNow();
    };

    if (typeof IntersectionObserver === "function") {
      observer = new IntersectionObserver(
        ([entry]) => {
          visible = entry?.isIntersecting === true;
          if (visible) schedule();
          else {
            cancelIdle?.();
            cancelIdle = null;
          }
        },
        { threshold: 0.2 },
      );
      if (targetRef.current) observer.observe(targetRef.current);
    } else {
      visible = true;
      schedule();
    }

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pointerdown", onInteraction, {
      once: true,
      passive: true,
    });
    window.addEventListener("keydown", onInteraction, { once: true });

    return () => {
      cancelIdle?.();
      observer?.disconnect();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pointerdown", onInteraction);
      window.removeEventListener("keydown", onInteraction);
    };
  }, [ready]);

  return { ready, targetRef };
}

import { logger } from "@elizaos/core";
import { useEffect, useRef, useState } from "react";
import {
  getActiveBackground,
  getBackground,
  registerBackground,
} from "./registry";
import { createSlowCloudsBackground } from "./slow-clouds";
import type { BackgroundHandle, BackgroundModule } from "./types";
import { SKY_BACKGROUND_COLOR } from "./types";

let defaultRegistered = false;
function ensureDefaultRegistered(): void {
  if (defaultRegistered) return;
  defaultRegistered = true;
  registerBackground(createSlowCloudsBackground());
}

function resolveModule(id: string | undefined): BackgroundModule | undefined {
  ensureDefaultRegistered();
  if (id) {
    return getBackground(id) ?? getActiveBackground();
  }
  return getActiveBackground();
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export interface BackgroundHostProps {
  moduleId?: string;
  className?: string;
}

export function BackgroundHost(props: BackgroundHostProps): JSX.Element {
  const { moduleId, className } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<BackgroundHandle | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const target = containerRef.current;
    if (!target) return;
    const mod = resolveModule(moduleId);
    if (!mod) {
      setFailed(true);
      return;
    }

    let handle: BackgroundHandle | null = null;
    try {
      handle = mod.mount(target);
      handleRef.current = handle;
      handle.update({ reducedMotion: prefersReducedMotion() });
    } catch (error) {
      logger.warn(
        "[BackgroundHost] Failed to mount background module; falling back to solid sky",
        { error: error instanceof Error ? error.message : String(error) },
      );
      setFailed(true);
      handleRef.current = null;
      return;
    }

    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const onChange = (event: MediaQueryListEvent): void => {
      handleRef.current?.update({ reducedMotion: event.matches });
    };
    media?.addEventListener?.("change", onChange);

    return () => {
      media?.removeEventListener?.("change", onChange);
      const current = handleRef.current;
      handleRef.current = null;
      if (current) {
        try {
          current.unmount();
        } catch (error) {
          logger.warn("[BackgroundHost] Unmount threw", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    };
  }, [moduleId]);

  return (
    <div
      ref={containerRef}
      className={className}
      data-eliza-background-host=""
      data-eliza-background-failed={failed ? "true" : "false"}
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 0,
        pointerEvents: "none",
        backgroundColor: SKY_BACKGROUND_COLOR,
      }}
      aria-hidden="true"
    />
  );
}

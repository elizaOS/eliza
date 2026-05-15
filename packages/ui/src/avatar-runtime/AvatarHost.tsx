import { logger } from "@elizaos/core";
import { useEffect, useRef, useState } from "react";
import { createJarvisAvatar } from "./presets/jarvis";
import { createVrmPlaceholderAvatar } from "./presets/vrm-placeholder";
import { createWaveformAvatar } from "./presets/waveform-shader";
import { getActiveAvatar, getAvatar, registerAvatar } from "./registry";
import type {
  AvatarContext,
  AvatarHandle,
  AvatarModule,
  AvatarSpeakingState,
} from "./types";

let defaultsRegistered = false;
function ensureDefaultsRegistered(): void {
  if (defaultsRegistered) return;
  defaultsRegistered = true;
  registerAvatar(createWaveformAvatar());
  registerAvatar(createJarvisAvatar());
  registerAvatar(createVrmPlaceholderAvatar());
}

export interface AvatarHostProps {
  moduleId?: string;
  audioLevel?: () => number;
  speakingState?: () => AvatarSpeakingState;
  ownerName?: string;
  className?: string;
}

function resolveAvatar(id: string | undefined): AvatarModule | undefined {
  ensureDefaultsRegistered();
  if (id) {
    return getAvatar(id) ?? getActiveAvatar();
  }
  return getActiveAvatar();
}

export function AvatarHost(props: AvatarHostProps): JSX.Element {
  const { moduleId, audioLevel, speakingState, ownerName, className } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const target = containerRef.current;
    if (!target) return;
    const mod = resolveAvatar(moduleId);
    if (!mod) {
      setFailed(true);
      return;
    }
    const ctx: AvatarContext = {
      audioLevel: audioLevel ?? (() => 0),
      speakingState: speakingState ?? (() => "idle"),
      theme: "sky",
      ownerName,
    };
    let handle: AvatarHandle | null = null;
    try {
      handle = mod.mount(target, ctx);
    } catch (error) {
      logger.warn(
        "[AvatarHost] Failed to mount avatar module; falling back to solid sky",
        { error: error instanceof Error ? error.message : String(error) },
      );
      setFailed(true);
      return;
    }
    return () => {
      try {
        handle?.unmount();
      } catch (error) {
        logger.warn("[AvatarHost] Unmount threw", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };
  }, [moduleId, audioLevel, speakingState, ownerName]);

  if (failed) {
    return (
      <div
        className={className}
        style={{
          width: "100%",
          height: "100%",
          background: "#1d91e8",
        }}
        aria-hidden="true"
      />
    );
  }

  return (
    <div
      ref={containerRef}
      className={className}
      data-eliza-avatar-host=""
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        display: "grid",
        placeItems: "center",
      }}
      aria-hidden="true"
    />
  );
}

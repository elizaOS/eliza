/**
 * Mirrors the canonical batch-or-realtime voice session into the iOS Lock
 * Screen and Dynamic Island Live Activity. The controller serializes native
 * lifecycle calls, clears orphaned activities after relaunch, and keeps public
 * system surfaces transcript-free by sending only a bounded phase.
 */

import { Capacitor } from "@capacitor/core";
import { useEffect, useRef } from "react";
import {
  type DictationActivityPhase,
  getLiveActivityPlugin,
  type LiveActivityPluginLike,
} from "../bridge/native-plugins";
import type { VoiceContinuousStatus } from "./voice-chat-types";

/**
 * Map the canonical voice status to a public Live Activity phase. `idle` while
 * a session remains active is a truthful ready state; barge-in remains part of
 * the in-flight thinking turn.
 */
export function mapContinuousStatusToPhase(
  status: VoiceContinuousStatus,
): DictationActivityPhase {
  switch (status) {
    case "speaking":
      return "speaking";
    case "thinking":
    case "interrupting":
      return "thinking";
    case "transcribing":
      return "transcribing";
    case "listening":
      return "listening";
    case "idle":
      return "ready";
  }
}

export interface VoiceLiveActivityState {
  active: boolean;
  phase: DictationActivityPhase;
}

interface ControllerDeps {
  /** iOS-only; the controller is inert on every other platform. */
  isIos: boolean;
  plugin?: LiveActivityPluginLike;
  sessionTitle?: string;
  reportError?: (error: unknown) => void;
}

export class VoiceLiveActivityController {
  private readonly isIos: boolean;
  private readonly plugin: LiveActivityPluginLike;
  private readonly sessionTitle: string;
  private readonly reportError: (error: unknown) => void;

  private queue: Promise<void> = Promise.resolve();
  private supported: boolean | null = null;
  private activityId: string | null = null;
  private starting = false;
  private lastPhase: DictationActivityPhase | null = null;
  private nativeReconciled = false;

  constructor(deps: ControllerDeps) {
    this.isIos = deps.isIos;
    this.plugin = deps.plugin ?? getLiveActivityPlugin();
    // The native bridge owns the localized default. An empty value keeps
    // custom titles verbatim while avoiding a second English-only authority.
    this.sessionTitle = deps.sessionTitle ?? "";
    this.reportError =
      deps.reportError ??
      ((error) => {
        console.warn("[iOS Live Activity] Native lifecycle unavailable", error);
      });
  }

  /** Reconcile the activity toward the desired session state. */
  sync(state: VoiceLiveActivityState): Promise<void> {
    if (!this.isIos || typeof this.plugin.start !== "function") {
      return Promise.resolve();
    }
    return this.enqueue(async () => {
      if (state.phase === "error") {
        await this.endActive("error");
        return;
      }
      if (!state.active) {
        await this.endActive("ended");
        return;
      }
      if (!this.activityId && !this.starting) {
        await this.beginActive(state.phase);
        return;
      }
      await this.maybeUpdate(state.phase);
    });
  }

  private enqueue(op: () => Promise<void>): Promise<void> {
    // error-policy:J4 the Live Activity is an ancillary system surface; a
    // native failure is reported but must not break the canonical voice path.
    this.queue = this.queue.then(op).catch((error: unknown) => {
      this.reportError(error);
    });
    return this.queue;
  }

  private async ensureSupported(): Promise<boolean> {
    if (this.supported !== null) return this.supported;
    if (typeof this.plugin.isSupported !== "function") {
      this.supported = false;
      return false;
    }
    const result = await this.plugin.isSupported();
    this.supported = Boolean(result?.supported && result?.enabled);
    return this.supported;
  }

  private async beginActive(phase: DictationActivityPhase): Promise<void> {
    if (!(await this.ensureSupported())) return;
    this.starting = true;
    this.nativeReconciled = true;
    try {
      const { activityId } = await this.plugin.start({
        sessionTitle: this.sessionTitle,
        phase,
      });
      this.activityId = activityId;
      this.lastPhase = phase;
    } finally {
      this.starting = false;
    }
  }

  private async maybeUpdate(phase: DictationActivityPhase): Promise<void> {
    if (!this.activityId) return;
    if (phase === this.lastPhase) return;
    await this.plugin.update({
      activityId: this.activityId,
      phase,
    });
    this.lastPhase = phase;
  }

  private async endActive(phase: "error" | "ended"): Promise<void> {
    if (!this.activityId && !this.starting && this.nativeReconciled) return;
    const activityId = this.activityId;
    this.activityId = null;
    this.starting = false;
    this.lastPhase = null;
    this.nativeReconciled = true;
    if (typeof this.plugin.end === "function") {
      await this.plugin.end(activityId ? { activityId, phase } : { phase });
    }
  }
}

export interface UseVoiceLiveActivityOptions {
  active: boolean;
  status: VoiceContinuousStatus;
  error?: boolean;
  sessionTitle?: string;
}

/**
 * React seam: mirror the final canonical voice-session state onto the iOS Live
 * Activity. Inert off iOS and ends any owned or stale activity on unmount.
 */
export function useVoiceLiveActivity(
  options: UseVoiceLiveActivityOptions,
): void {
  const { active, status, error = false, sessionTitle } = options;
  const controllerRef = useRef<VoiceLiveActivityController | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = new VoiceLiveActivityController({
      isIos: Capacitor.getPlatform() === "ios",
      sessionTitle,
    });
  }

  useEffect(() => {
    void controllerRef.current?.sync({
      active,
      phase: error ? "error" : mapContinuousStatusToPhase(status),
    });
  }, [active, error, status]);

  useEffect(() => {
    const controller = controllerRef.current;
    return () => {
      void controller?.sync({
        active: false,
        phase: "ended",
      });
    };
  }, []);
}

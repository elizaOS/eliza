/**
 * Drives the iOS voice/dictation Live Activity from the continuous-chat session
 * lifecycle (issue #12185, sub-issue 2). The `ElizaLiveActivity` native bridge
 * (packages/app-core/platforms/ios/App/App/ElizaLiveActivityBridge.swift) starts
 * the Lock Screen + Dynamic Island activity when a voice session goes active,
 * pushes its `phase`/`transcript` as the session progresses, and ends it when
 * the session stops.
 *
 * `DictationLiveActivityController` serializes ActivityKit calls through a
 * promise chain (so end never races ahead of start), throttles content pushes to
 * respect the ActivityKit update budget, and no-ops off iOS / when the user has
 * Live Activities disabled. `useDictationLiveActivity` is the React seam wired
 * into `useContinuousChat`. The pure mapping/snippet helpers are unit-tested.
 */

import { Capacitor } from "@capacitor/core";
import { useEffect, useRef } from "react";
import {
  type DictationActivityPhase,
  getLiveActivityPlugin,
  type LiveActivityPluginLike,
} from "../bridge/native-plugins";
import type { VoiceContinuousStatus } from "./voice-chat-types";

/** Longest transcript tail pushed to the activity; older text is dropped. */
export const DICTATION_SNIPPET_MAX_CHARS = 120;
/** Minimum gap between transcript-only content pushes (ActivityKit budget). */
export const DICTATION_MIN_UPDATE_INTERVAL_MS = 800;

/**
 * Map a continuous-chat status to the Live Activity phase. `idle` while the
 * session is still active is the brief settle after speech, surfaced as
 * `transcribing`; `interrupting` folds into `thinking`.
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
    case "idle":
      return "transcribing";
    default:
      return "recording";
  }
}

/** Keep only the last `max` characters, prefixing an ellipsis when trimmed. */
export function truncateTranscriptSnippet(
  text: string,
  max: number = DICTATION_SNIPPET_MAX_CHARS,
): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return `…${collapsed.slice(collapsed.length - max)}`;
}

export interface DictationLiveActivityState {
  active: boolean;
  phase: DictationActivityPhase;
  transcript: string;
}

interface ControllerDeps {
  /** iOS-only; the controller is inert on every other platform. */
  isIos: boolean;
  plugin?: LiveActivityPluginLike;
  now?: () => number;
  minUpdateIntervalMs?: number;
  sessionTitle?: string;
}

export class DictationLiveActivityController {
  private readonly isIos: boolean;
  private readonly plugin: LiveActivityPluginLike;
  private readonly now: () => number;
  private readonly minUpdateIntervalMs: number;
  private readonly sessionTitle: string;

  private queue: Promise<void> = Promise.resolve();
  private supported: boolean | null = null;
  private activityId: string | null = null;
  private starting = false;
  private lastPhase: DictationActivityPhase | null = null;
  private lastSnippet = "";
  private lastPushMs = 0;

  constructor(deps: ControllerDeps) {
    this.isIos = deps.isIos;
    this.plugin = deps.plugin ?? getLiveActivityPlugin();
    this.now = deps.now ?? (() => Date.now());
    this.minUpdateIntervalMs =
      deps.minUpdateIntervalMs ?? DICTATION_MIN_UPDATE_INTERVAL_MS;
    this.sessionTitle = deps.sessionTitle ?? "Voice session";
  }

  /** Reconcile the activity toward the desired session state. */
  sync(state: DictationLiveActivityState): Promise<void> {
    if (!this.isIos || typeof this.plugin.start !== "function") {
      return Promise.resolve();
    }
    const snippet = truncateTranscriptSnippet(state.transcript);
    return this.enqueue(async () => {
      if (!state.active) {
        await this.endActive();
        return;
      }
      if (!this.activityId && !this.starting) {
        await this.beginActive(state.phase, snippet);
        return;
      }
      await this.maybeUpdate(state.phase, snippet);
    });
  }

  private enqueue(op: () => Promise<void>): Promise<void> {
    // error-policy:J4 the Live Activity is a UI adornment — a failed
    // ActivityKit call (e.g. user disabled Live Activities) must not break the
    // voice session, so it degrades to "no activity" rather than throwing.
    this.queue = this.queue.then(op).catch(() => {});
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

  private async beginActive(
    phase: DictationActivityPhase,
    snippet: string,
  ): Promise<void> {
    if (!(await this.ensureSupported())) return;
    this.starting = true;
    try {
      const { activityId } = await this.plugin.start({
        sessionTitle: this.sessionTitle,
        phase,
        transcript: snippet,
      });
      this.activityId = activityId;
      this.lastPhase = phase;
      this.lastSnippet = snippet;
      this.lastPushMs = this.now();
    } finally {
      this.starting = false;
    }
  }

  private async maybeUpdate(
    phase: DictationActivityPhase,
    snippet: string,
  ): Promise<void> {
    if (!this.activityId) return;
    const phaseChanged = phase !== this.lastPhase;
    const snippetChanged = snippet !== this.lastSnippet;
    if (!phaseChanged && !snippetChanged) return;
    // Phase changes push immediately; transcript-only churn is throttled.
    if (!phaseChanged && this.now() - this.lastPushMs < this.minUpdateIntervalMs) {
      return;
    }
    await this.plugin.update({
      activityId: this.activityId,
      phase,
      transcript: snippet,
    });
    this.lastPhase = phase;
    this.lastSnippet = snippet;
    this.lastPushMs = this.now();
  }

  private async endActive(): Promise<void> {
    if (!this.activityId && !this.starting) return;
    const activityId = this.activityId;
    this.activityId = null;
    this.starting = false;
    this.lastPhase = null;
    this.lastSnippet = "";
    if (typeof this.plugin.end === "function") {
      await this.plugin.end(activityId ? { activityId } : undefined);
    }
  }
}

export interface UseDictationLiveActivityOptions {
  active: boolean;
  status: VoiceContinuousStatus;
  transcript: string;
  sessionTitle?: string;
}

/**
 * React seam: mirror the continuous-chat session state onto the iOS Live
 * Activity. Inert off iOS. Ends the activity on unmount.
 */
export function useDictationLiveActivity(
  options: UseDictationLiveActivityOptions,
): void {
  const { active, status, transcript, sessionTitle } = options;
  const controllerRef = useRef<DictationLiveActivityController | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = new DictationLiveActivityController({
      isIos: Capacitor.getPlatform() === "ios",
      sessionTitle,
    });
  }

  useEffect(() => {
    void controllerRef.current?.sync({
      active,
      phase: mapContinuousStatusToPhase(status),
      transcript,
    });
  }, [active, status, transcript]);

  useEffect(() => {
    const controller = controllerRef.current;
    return () => {
      void controller?.sync({ active: false, phase: "recording", transcript: "" });
    };
  }, []);
}

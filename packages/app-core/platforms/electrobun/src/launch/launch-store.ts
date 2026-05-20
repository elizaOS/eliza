import type { JsonValue } from "@elizaos/electrobun-carrots";
import { createUnknownDatabaseSnapshot } from "../database";
import type {
  LaunchEvent,
  LaunchEventsTailResult,
  LaunchPhase,
  LaunchSnapshot,
} from "./types";

const DEFAULT_MAX_EVENTS = 500;

function emptySnapshot(now: () => Date): LaunchSnapshot {
  return {
    phase: "static-shell",
    agent: {
      state: "not_started",
      port: null,
      apiBase: null,
      startedAt: null,
      error: null,
    },
    boot: {
      runtimePhase: null,
      pluginsLoaded: null,
      pluginsFailed: null,
      database: null,
    },
    database: createUnknownDatabaseSnapshot(now().toISOString()),
    auth: {
      checked: false,
      required: null,
    },
    onboarding: {
      checked: false,
      complete: null,
      requiredGate: null,
    },
    satellites: {
      seeded: false,
      requiredStarted: false,
      errors: [],
    },
    localModel: {
      backgroundDownloadQueued: false,
      blocking: false,
    },
    diagnostics: {
      logPath: "",
      statusPath: "",
    },
    recovery: {
      canRetry: false,
      canOpenLogs: false,
      canCreateBugReport: false,
    },
    updatedAt: now().toISOString(),
  };
}

export class LaunchStore {
  private snapshot: LaunchSnapshot;
  private readonly events: LaunchEvent[] = [];
  private sequence = 0;
  private readonly maxEvents: number;
  private readonly now: () => Date;

  constructor(options?: {
    initialSnapshot?: LaunchSnapshot;
    maxEvents?: number;
    now?: () => Date;
  }) {
    this.now = options?.now ?? (() => new Date());
    this.maxEvents = options?.maxEvents ?? DEFAULT_MAX_EVENTS;
    this.snapshot = options?.initialSnapshot ?? emptySnapshot(this.now);
  }

  getSnapshot(): LaunchSnapshot {
    return structuredClone(this.snapshot);
  }

  update(
    snapshot: LaunchSnapshot,
    event?: { name: string; payload?: JsonValue },
  ): LaunchSnapshot {
    const previousPhase = this.snapshot.phase;
    this.snapshot = structuredClone(snapshot);
    if (event) {
      this.recordEvent(event.name, snapshot.phase, event.payload);
    } else if (previousPhase !== snapshot.phase) {
      this.recordEvent("launch.phase.changed", snapshot.phase, {
        previousPhase,
        phase: snapshot.phase,
      });
    }
    return this.getSnapshot();
  }

  recordEvent(
    name: string,
    phase: LaunchPhase = this.snapshot.phase,
    payload?: JsonValue,
  ): LaunchEvent {
    this.sequence += 1;
    const event: LaunchEvent = {
      sequence: this.sequence,
      phase,
      name,
      timestamp: this.now().toISOString(),
    };
    if (payload !== undefined) event.payload = structuredClone(payload);
    this.events.push(event);
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
    return structuredClone(event);
  }

  tailEvents(afterSequence = 0, limit = 100): LaunchEventsTailResult {
    const cappedLimit = Math.max(1, Math.min(limit, this.maxEvents));
    const events = this.events
      .filter((event) => event.sequence > afterSequence)
      .slice(-cappedLimit);
    return {
      events: structuredClone(events),
      nextSequence: this.sequence,
    };
  }

  reset(snapshot?: LaunchSnapshot): void {
    this.snapshot = snapshot ?? emptySnapshot(this.now);
    this.events.length = 0;
    this.sequence = 0;
  }
}

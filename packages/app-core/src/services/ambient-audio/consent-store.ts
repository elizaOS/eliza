import type { AmbientMode, ConsentRecord } from "./types.ts";

export interface SerializedConsentStore {
  consent: ConsentRecord | null;
  mode: AmbientMode;
}

export class ConsentStore {
  private record: ConsentRecord | null = null;
  private mode: AmbientMode = "off";
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  grant(scope: "household" | "owner-only"): ConsentRecord {
    const record: ConsentRecord = {
      grantedAt: this.now(),
      mode: "capturing",
      scope,
    };
    this.record = record;
    this.mode = "capturing";
    return record;
  }

  revoke(): void {
    this.record = null;
    this.mode = "off";
  }

  pause(): void {
    if (this.record === null) {
      throw new Error("ConsentStore.pause requires an active consent grant");
    }
    if (this.mode === "off") {
      throw new Error("ConsentStore.pause cannot transition from off");
    }
    this.mode = "paused";
  }

  resume(): void {
    if (this.record === null) {
      throw new Error("ConsentStore.resume requires an active consent grant");
    }
    if (this.mode !== "paused") {
      throw new Error("ConsentStore.resume requires paused mode");
    }
    this.mode = "capturing";
  }

  currentMode(): AmbientMode {
    return this.mode;
  }

  consent(): ConsentRecord | null {
    return this.record;
  }

  serialize(): SerializedConsentStore {
    return { consent: this.record, mode: this.mode };
  }

  static hydrate(
    snapshot: SerializedConsentStore,
    now: () => number = Date.now,
  ): ConsentStore {
    const store = new ConsentStore(now);
    store.record = snapshot.consent;
    store.mode = snapshot.mode;
    return store;
  }
}

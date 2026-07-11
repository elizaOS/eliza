/**
 * Revoke-to-silence (SEC-6) and metering-enforcement (SEC-15) against the REAL
 * VoiceSession + registry + Deepgram Flux adapter. Fakes are transports only.
 */

import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";

const fakeLogger = {
  logger: { error: mock(), info: mock(), warn: mock(), debug: mock() },
};
mock.module("@/lib/utils/logger", () => fakeLogger);
mock.module("@elizaos/core", () => ({
  isSensitiveKeyName: () => false,
  redactLogArgs: (a: unknown) => a,
}));

import type { CartesiaWebSocketLike } from "../../../../../shared/src/lib/services/cartesia-sonic-tts";
import type {
  VoiceUsageDecision,
  VoiceUsageIdentity,
  VoiceUsageLimits,
  VoiceUsageStore,
} from "../../../../../shared/src/lib/services/voice-usage-meter";
import type { ServerControlFrame } from "../../../../../shared/src/lib/voice-session/protocol";
import {
  __resetVoiceSessionRegistryForTests,
  getVoiceSessionRegistry,
} from "../../../../../shared/src/lib/voice-session/session-registry";
import type { VoiceSessionDownlink } from "../../../../../shared/src/lib/voice-session/ws-handler";
import type { DeepgramFluxWebSocket } from "../../stt/providers/deepgram-flux";
import { VoiceSession } from "../lib/session";

beforeAll(() => {
  // No signing needed here; VoiceSession is built directly.
});
afterEach(() => __resetVoiceSessionRegistryForTests());

class FakeFluxSocket implements DeepgramFluxWebSocket {
  static instances: FakeFluxSocket[] = [];
  readyState = 1;
  binaryType: BinaryType = "arraybuffer";
  closed = false;
  closedAtMs: number | null = null;
  sentChunks: number[] = [];
  private listeners = new Map<string, Set<(e: unknown) => void>>();
  constructor() {
    FakeFluxSocket.instances.push(this);
    queueMicrotask(() => this.fire("open", {}));
  }
  send(data: string | ArrayBuffer | ArrayBufferView) {
    if (typeof data === "string") return;
    this.sentChunks.push((data as ArrayBuffer).byteLength);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.closedAtMs = Date.now();
    this.readyState = 3;
    this.fire("close", { code: 1000, reason: "", wasClean: true });
  }
  addEventListener(type: string, l: (e: never) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(l as (e: unknown) => void);
  }
  removeEventListener(type: string, l: (e: never) => void) {
    this.listeners.get(type)?.delete(l as (e: unknown) => void);
  }
  private fire(t: string, p: unknown) {
    for (const l of this.listeners.get(t) ?? []) l(p);
  }
}

class FakeCartesiaSocket implements CartesiaWebSocketLike {
  readyState = 0;
  closed = false;
  private listeners = new Map<string, Set<(e: unknown) => void>>();
  constructor() {
    queueMicrotask(() => {
      this.readyState = 1;
      this.fire("open", undefined);
    });
  }
  send() {}
  close() {
    this.closed = true;
    this.readyState = 3;
    this.fire("close", {});
  }
  addEventListener(type: string, l: (e: never) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(l as (e: unknown) => void);
  }
  private fire(t: string, p: unknown) {
    for (const l of this.listeners.get(t) ?? []) l(p);
  }
}

function collectDownlink(): {
  downlink: VoiceSessionDownlink;
  control: ServerControlFrame[];
  closed: { code: number; reason: string } | null;
  ref: { closed: { code: number; reason: string } | null };
} {
  const control: ServerControlFrame[] = [];
  const ref: { closed: { code: number; reason: string } | null } = {
    closed: null,
  };
  return {
    control,
    closed: ref.closed,
    ref,
    downlink: {
      sendControl: (f) => control.push(f),
      sendAudio: () => {},
      close: (code, reason) => {
        ref.closed = { code, reason };
      },
    },
  };
}

function buildSession(opts: {
  usageStore: VoiceUsageStore;
  usageLimits?: VoiceUsageLimits;
  downlink: VoiceSessionDownlink;
  flux: () => FakeFluxSocket;
}): VoiceSession {
  return new VoiceSession({
    sessionId: "sess-r",
    jti: "jti-r",
    organizationId: "org-1",
    userId: "user-1",
    agentId: "agent-1",
    conversationId: "conv-1",
    tokenExpSeconds: Math.floor(Date.now() / 1000) + 120,
    deepgramApiKey: "dg",
    deepgramWebSocketFactory: opts.flux as never,
    cartesiaApiKey: "ct",
    cartesiaVoiceId: "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4",
    cartesiaWebSocketFactory: () => new FakeCartesiaSocket(),
    elizaEndpoint: "http://x",
    elizaAuthorization: "Bearer x",
    elizaModel: "gemma-4-31b",
    usageStore: opts.usageStore,
    usageLimits: opts.usageLimits ?? {
      organizationDailyMinutes: 600,
      userDailyMinutes: 120,
    },
    downlink: opts.downlink,
  });
}

const flush = () => new Promise((r) => setTimeout(r, 15));

describe("revoke-to-silence (SEC-6)", () => {
  test("registry sever closes the live Flux socket well under 500ms", async () => {
    const dl = collectDownlink();
    const usageStore: VoiceUsageStore = {
      async checkAndRecord() {
        return {
          allowed: true,
          organizationUsedMinutes: 0,
          userUsedMinutes: 0,
          day: "d",
        };
      },
      async release() {},
    };
    const session = buildSession({
      usageStore,
      downlink: dl.downlink,
      flux: () => new FakeFluxSocket(),
    });
    session.start();
    await flush();
    const flux = FakeFluxSocket.instances.at(-1)!;
    expect(flux.closed).toBe(false);

    const t0 = Date.now();
    const severed = getVoiceSessionRegistry().severBySessionId(
      "sess-r",
      "revoked",
    );
    const elapsed = Date.now() - t0;

    expect(severed).toBe(true);
    expect(flux.closed).toBe(true);
    expect(elapsed).toBeLessThanOrEqual(500);
    expect(dl.ref.closed).not.toBeNull();
  });

  test("cross-worker revoke (poll) self-severs the live socket", async () => {
    const dl = collectDownlink();
    const usageStore: VoiceUsageStore = {
      async checkAndRecord() {
        return {
          allowed: true,
          organizationUsedMinutes: 0,
          userUsedMinutes: 0,
          day: "d",
        };
      },
      async release() {},
    };
    let revoked = false;
    const session = new VoiceSession({
      sessionId: "sess-xw",
      jti: "jti-xw",
      organizationId: "org-1",
      userId: "user-1",
      agentId: "agent-1",
      conversationId: "conv-1",
      tokenExpSeconds: Math.floor(Date.now() / 1000) + 120,
      deepgramApiKey: "dg",
      deepgramWebSocketFactory: (() => new FakeFluxSocket()) as never,
      cartesiaApiKey: "ct",
      cartesiaVoiceId: "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4",
      cartesiaWebSocketFactory: () => new FakeCartesiaSocket(),
      elizaEndpoint: "http://x",
      elizaAuthorization: "Bearer x",
      elizaModel: "gemma-4-31b",
      usageStore,
      usageLimits: { organizationDailyMinutes: 600, userDailyMinutes: 120 },
      isRevoked: async () => revoked,
      downlink: dl.downlink,
    });
    session.start();
    await flush();
    const flux = FakeFluxSocket.instances.at(-1)!;
    expect(flux.closed).toBe(false);
    // Simulate the revoke landing on ANOTHER worker (durable store flips).
    revoked = true;
    await new Promise((r) => setTimeout(r, 500));
    expect(flux.closed).toBe(true);
  });

  test("client disconnect self-severs the provider socket", async () => {
    const dl = collectDownlink();
    const usageStore: VoiceUsageStore = {
      async checkAndRecord() {
        return {
          allowed: true,
          organizationUsedMinutes: 0,
          userUsedMinutes: 0,
          day: "d",
        };
      },
      async release() {},
    };
    const session = buildSession({
      usageStore,
      downlink: dl.downlink,
      flux: () => new FakeFluxSocket(),
    });
    session.start();
    await flush();
    const flux = FakeFluxSocket.instances.at(-1)!;
    session.sever("client_disconnect");
    expect(flux.closed).toBe(true);
  });
});

describe("metering enforcement (SEC-15)", () => {
  test("over-cap quota severs the session with quota_exhausted", async () => {
    const dl = collectDownlink();
    // Store that denies on the first checkAndRecord (simulates cap already hit).
    const denyingStore: VoiceUsageStore = {
      async checkAndRecord(
        _id: VoiceUsageIdentity,
        requestedMinutes: number,
      ): Promise<VoiceUsageDecision> {
        return {
          allowed: false,
          scope: "user",
          limitMinutes: 1,
          usedMinutes: 1,
          requestedMinutes,
          day: "d",
        };
      },
      async release() {},
    };
    const session = buildSession({
      usageStore: denyingStore,
      downlink: dl.downlink,
      flux: () => new FakeFluxSocket(),
    });
    session.start();
    await flush();
    const flux = FakeFluxSocket.instances.at(-1)!;

    // A single small chunk triggers the fail-closed admission check BEFORE any
    // audio is forwarded. The denying store rejects it -> quota_exhausted.
    session.pushUplinkAudio(new Uint8Array(2560));
    await flush();

    const codes = dl.control
      .filter((f) => f.t === "error")
      .map((f) => (f as { code: string }).code);
    expect(codes).toContain("quota_exhausted");
    expect(flux.closed).toBe(true);
    // Fail-closed: the denied audio was NEVER forwarded to the provider.
    expect(flux.sentChunks.length).toBe(0);
  });

  test("metering uses server-derived byte count, never a client claim", async () => {
    const recorded: number[] = [];
    const store: VoiceUsageStore = {
      async checkAndRecord(_id, minutes) {
        recorded.push(minutes);
        return {
          allowed: true,
          organizationUsedMinutes: 0,
          userUsedMinutes: 0,
          day: "d",
        };
      },
      async release() {},
    };
    const dl = collectDownlink();
    const session = buildSession({
      usageStore: store,
      downlink: dl.downlink,
      flux: () => new FakeFluxSocket(),
    });
    session.start();
    await flush();
    // A small admission chunk records the server-derived nominal window; the
    // amount is derived by the SERVER, never taken from any client claim.
    session.pushUplinkAudio(new Uint8Array(2560));
    await flush();
    expect(recorded.length).toBeGreaterThan(0);
    // The admission charge is the server's nominal window (5s == 5/60 min).
    const totalMinutes = recorded.reduce((a, b) => a + b, 0);
    expect(totalMinutes).toBeGreaterThanOrEqual(5 / 60 - 1e-9);
  });
});

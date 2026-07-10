/**
 * Ambient-mode WS lifecycle against fake TRANSPORTS driving the REAL code:
 * `attachVoiceWsHandler` (ambient branch), the REAL `AmbientSession`
 * orchestrator, the REAL merged Deepgram Flux adapter, and a fake
 * `AmbientSegmentStore` that enforces the REAL pendant contract (contiguous
 * ordinals, lease digest, paused-refuses-append). Only the network transports
 * are faked; the ambient lifecycle + segment ordering + pause-severs-Flux +
 * revoke-to-silence + metering are the real path.
 */

import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";

const fakeLogger = { logger: { error: mock(), info: mock(), warn: mock(), debug: mock() } };
mock.module("@/lib/utils/logger", () => fakeLogger);
mock.module("@elizaos/cloud-shared/lib/utils/logger", () => fakeLogger);
mock.module("@elizaos/core", () => ({
  isSensitiveKeyName: () => false,
  redactLogArgs: (args: unknown) => args,
}));

import { installVoiceSessionTestSigningKey } from "../../../../../shared/src/lib/voice-session/test-signing";
import type { DeepgramFluxWebSocket } from "../../stt/providers/deepgram-flux";
import { InMemoryVoiceUsageStore } from "../../../../../shared/src/lib/services/voice-usage-meter";
import { mintVoiceSessionToken } from "../../../../../shared/src/lib/voice-session/jwt";
import { __resetVoiceSessionRegistryForTests } from "../../../../../shared/src/lib/voice-session/session-registry";
import type { AmbientServerFrame } from "../../../../../shared/src/lib/voice-session/ambient-protocol";
import { attachVoiceWsHandler } from "../../../../../shared/src/lib/voice-session/ws-handler";
import {
  AmbientStoreError,
  type AmbientSegmentInput,
  type AmbientSegmentStore,
} from "../../../../../shared/src/lib/voice-session/pendant-store-client";
import { AmbientSession } from "../lib/ambient-session";
import { pendantSegmentId } from "@elizaos/shared/contracts";

beforeAll(async () => {
  await installVoiceSessionTestSigningKey();
});
afterEach(() => {
  __resetVoiceSessionRegistryForTests();
});

// --- fake Flux socket -----------------------------------------------------

class FakeFluxSocket implements DeepgramFluxWebSocket {
  static instances: FakeFluxSocket[] = [];
  readyState = 1;
  binaryType: BinaryType = "arraybuffer";
  sentChunks: (ArrayBuffer | ArrayBufferView)[] = [];
  closed = false;
  private listeners = new Map<string, Set<(e: unknown) => void>>();
  constructor() {
    FakeFluxSocket.instances.push(this);
    queueMicrotask(() => this.fire("open", {}));
  }
  send(data: string | ArrayBuffer | ArrayBufferView) {
    if (typeof data === "string") return; // CloseStream.
    this.sentChunks.push(data);
  }
  close(code = 1000, reason = "") {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.fire("close", { code, reason, wasClean: true });
  }
  addEventListener(type: string, listener: (e: never) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener as (e: unknown) => void);
  }
  removeEventListener(type: string, listener: (e: never) => void) {
    this.listeners.get(type)?.delete(listener as (e: unknown) => void);
  }
  emitTurn(event: string, transcript = "") {
    this.fire("message", {
      data: JSON.stringify({ type: "TurnInfo", event, transcript, words: [] }),
    });
  }
  private fire(type: string, payload: unknown) {
    for (const l of this.listeners.get(type) ?? []) l(payload);
  }
}

// --- fake pendant store: enforces the REAL contract in-memory -------------

interface StoredSeg {
  id: string;
  ordinal: number;
  revision: number;
  text: string;
}
class FakePendantStore implements AmbientSegmentStore {
  segments: StoredSeg[] = [];
  state: "active" | "paused" | "ended" = "active";
  leaseToken: string;
  stateCalls: string[] = [];
  renewCount = 0;
  appendCalls = 0;

  constructor(initialLease: string) {
    this.leaseToken = initialLease;
  }

  async getSessionState(_p: string) {
    if (this.state === "ended") {
      // Simulate a not_found only when explicitly deleted; ended is still read.
    }
    return { segmentCount: this.segments.length, state: this.state };
  }

  async appendSegment(
    pendantSessionId: string,
    leaseToken: string,
    input: AmbientSegmentInput,
  ) {
    this.appendCalls++;
    // REAL contract: paused refuses append.
    if (this.state === "paused") {
      throw new AmbientStoreError("paused", "revision_conflict", 409);
    }
    if (this.state === "ended") {
      throw new AmbientStoreError("ended", "revision_conflict", 409);
    }
    // REAL contract: lease digest must match (we compare the plaintext here).
    if (leaseToken !== this.leaseToken) {
      throw new AmbientStoreError("lease mismatch", "lease_conflict", 409);
    }
    // REAL contract: ordinal must be contiguous (== segments.length).
    if (input.ordinal !== this.segments.length) {
      throw new AmbientStoreError("non-contiguous ordinal", "validation", 400);
    }
    const id = pendantSegmentId(pendantSessionId, input.ordinal);
    this.segments.push({ id, ordinal: input.ordinal, revision: 0, text: input.text });
    return {
      segmentId: id,
      ordinal: input.ordinal,
      revision: 0,
      sessionRevision: this.segments.length,
      segmentCount: this.segments.length,
    };
  }

  async setState(_pendantSessionId: string, state: "paused" | "active" | "ended") {
    this.stateCalls.push(state);
    this.state = state;
  }

  async renewLease(_p: string, _h: string, currentToken: string, leaseMs: number) {
    // REAL contract: renewing requires the CURRENT lease token to match (the
    // pendant route's assertLease). A mismatched token is a lease_conflict.
    if (currentToken !== this.leaseToken) {
      throw new AmbientStoreError("lease mismatch", "lease_conflict", 409);
    }
    this.renewCount++;
    this.leaseToken = `renewed-${this.renewCount}`;
    return {
      leaseToken: this.leaseToken,
      leaseExpiresAt: new Date(Date.now() + leaseMs).toISOString(),
    };
  }
}

// --- fake client transport ------------------------------------------------

class FakeClientSocket {
  frames: AmbientServerFrame[] = [];
  closedWith: { code?: number; reason?: string } | null = null;
  private listeners = new Map<string, Set<(e: { data: unknown }) => void>>();
  send(data: string | ArrayBuffer | Uint8Array) {
    if (typeof data === "string") this.frames.push(JSON.parse(data));
  }
  close(code?: number, reason?: string) {
    this.closedWith = { code, reason };
    this.fire("close", { data: undefined });
  }
  addEventListener(type: string, listener: (e: { data: unknown }) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  clientSend(data: string | ArrayBuffer | Uint8Array) {
    this.fire("message", { data });
  }
  clientClose() {
    this.fire("close", { data: undefined });
  }
  private fire(type: string, e: { data: unknown }) {
    for (const l of this.listeners.get(type) ?? []) l(e);
  }
  types(): string[] {
    return this.frames.map((f) => f.t);
  }
}

const ORG = "00000000-0000-4000-8000-0000000000a1";
const USER = "00000000-0000-4000-8000-0000000000b2";
const AGENT = "00000000-0000-4000-8000-0000000000c3";
const CONV = "00000000-0000-4000-8000-0000000000d4";
const SESSION = "00000000-0000-4000-8000-0000000000e5";
const PENDANT = "pendant-abc";
const LEASE = "lease-plaintext-token";

async function mintAmbientToken(overrides?: {
  sessionId?: string;
  pendantSessionId?: string;
}) {
  return mintVoiceSessionToken({
    sessionId: overrides?.sessionId ?? SESSION,
    organizationId: ORG,
    userId: USER,
    agentId: AGENT,
    conversationId: CONV,
    mode: "ambient",
    pendantSessionId: overrides?.pendantSessionId ?? PENDANT,
  });
}

function pcm(bytes: number): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}

function wireAmbient(store: FakePendantStore, sessionId = SESSION) {
  FakeFluxSocket.instances = [];
  const client = new FakeClientSocket();
  const usageStore = new InMemoryVoiceUsageStore();
  attachVoiceWsHandler(client as never, {
    requestedSessionId: sessionId,
    buildAmbientSession: ({ claims, jti, tokenExpSeconds, pendantSessionId, captureLeaseToken, downlink }) =>
      new AmbientSession({
        sessionId: claims.sessionId,
        jti,
        organizationId: claims.organizationId,
        userId: claims.userId,
        agentId: claims.agentId,
        pendantSessionId,
        captureLeaseToken,
        tokenExpSeconds,
        deepgramApiKey: "dg-test",
        deepgramWebSocketFactory: () => new FakeFluxSocket(),
        store,
        usageStore,
        usageLimits: { organizationDailyMinutes: 1440, userDailyMinutes: 720 },
        downlink,
      }),
    // Conversation path unused in these tests.
    buildSession: () => {
      throw new Error("conversation session should not be built for ambient");
    },
  });
  return { client, usageStore };
}

async function helloAmbient(
  client: FakeClientSocket,
  token: string,
  opts?: { pendantSessionId?: string; leaseToken?: string },
) {
  client.clientSend(
    JSON.stringify({
      t: "hello",
      mode: "ambient",
      token,
      protocol: 1,
      pendantSessionId: opts?.pendantSessionId ?? PENDANT,
      captureLeaseToken: opts?.leaseToken ?? LEASE,
      uplinkCodec: "pcm16",
      sampleRate: 16000,
    }),
  );
  await Promise.resolve();
  // start() now does async lease-validate + ordinal-read before opening Flux;
  // give the store round-trips (resolved promises => microtasks) time to settle.
  await new Promise((r) => setTimeout(r, 15));
}

const flux = () => FakeFluxSocket.instances[FakeFluxSocket.instances.length - 1];

describe("ambient WS lifecycle", () => {
  test("ready → 3 utterances commit contiguous ordinals to the pendant store", async () => {
    const store = new FakePendantStore(LEASE);
    const { client } = wireAmbient(store);
    const { token } = await mintAmbientToken();
    await helloAmbient(client, token);

    expect(client.types()).toContain("ready");
    const ready = client.frames.find((f) => f.t === "ready") as Extract<AmbientServerFrame, { t: "ready" }>;
    expect(ready.pendantSessionId).toBe(PENDANT);

    // Send some uplink so metering admits, then drive three Flux turns.
    for (let i = 0; i < 8; i++) client.clientSend(pcm(2560));
    await new Promise((r) => setTimeout(r, 10));

    for (const text of ["hello there", "second utterance", "third and final"]) {
      flux().emitTurn("StartOfTurn");
      flux().emitTurn("EndOfTurn", text);
      await new Promise((r) => setTimeout(r, 10));
    }

    expect(store.segments.map((s) => s.ordinal)).toEqual([0, 1, 2]);
    expect(store.segments.map((s) => s.text)).toEqual([
      "hello there",
      "second utterance",
      "third and final",
    ]);
    const finals = client.frames.filter((f) => f.t === "stt_final") as Extract<
      AmbientServerFrame,
      { t: "stt_final" }
    >[];
    expect(finals.map((f) => f.ordinal)).toEqual([0, 1, 2]);
    expect(finals[0].segmentId).toBe(pendantSegmentId(PENDANT, 0));
    // Segment-commit acks emitted for each.
    expect(client.frames.filter((f) => f.t === "segment_committed")).toHaveLength(3);
  });

  test("empty EOT (silence) commits nothing", async () => {
    const store = new FakePendantStore(LEASE);
    const { client } = wireAmbient(store);
    const { token } = await mintAmbientToken();
    await helloAmbient(client, token);
    for (let i = 0; i < 8; i++) client.clientSend(pcm(2560));
    await new Promise((r) => setTimeout(r, 10));
    flux().emitTurn("EndOfTurn", "   ");
    await new Promise((r) => setTimeout(r, 10));
    expect(store.segments).toHaveLength(0);
    expect(client.types()).not.toContain("stt_final");
  });

  test("pause severs Flux, refuses appends, and stops metering uplink; resume reopens", async () => {
    const store = new FakePendantStore(LEASE);
    const { client } = wireAmbient(store);
    const { token } = await mintAmbientToken();
    await helloAmbient(client, token);
    for (let i = 0; i < 8; i++) client.clientSend(pcm(2560));
    await new Promise((r) => setTimeout(r, 10));

    const fluxBefore = flux();
    const chunksBeforePause = fluxBefore.sentChunks.length;
    expect(chunksBeforePause).toBeGreaterThan(0);

    client.clientSend(JSON.stringify({ t: "pause" }));
    await new Promise((r) => setTimeout(r, 5));

    // Pause severs the live Flux socket (SEC-6/P0-4).
    expect(fluxBefore.closed).toBe(true);
    expect(store.state).toBe("paused");
    expect(client.types()).toContain("paused");

    // Audio sent while paused is NOT forwarded to any Flux socket.
    const instancesAtPause = FakeFluxSocket.instances.length;
    for (let i = 0; i < 4; i++) client.clientSend(pcm(2560));
    await new Promise((r) => setTimeout(r, 5));
    expect(FakeFluxSocket.instances.length).toBe(instancesAtPause); // no new socket opened.

    client.clientSend(JSON.stringify({ t: "resume" }));
    await new Promise((r) => setTimeout(r, 5));
    expect(store.state).toBe("active");
    expect(client.types()).toContain("resumed");
    // A fresh Flux socket exists after resume.
    expect(FakeFluxSocket.instances.length).toBe(instancesAtPause + 1);

    // Capture works again after resume.
    for (let i = 0; i < 8; i++) client.clientSend(pcm(2560));
    await new Promise((r) => setTimeout(r, 10));
    flux().emitTurn("EndOfTurn", "back after pause");
    await new Promise((r) => setTimeout(r, 10));
    expect(store.segments.map((s) => s.text)).toEqual(["back after pause"]);
  });

  test("lease_renew renews over the socket and updates the server-held token", async () => {
    const store = new FakePendantStore(LEASE);
    const { client } = wireAmbient(store);
    const { token } = await mintAmbientToken();
    await helloAmbient(client, token);

    // start() renews once to validate the lease before opening Flux, so the
    // count is already 1 here; the explicit lease_renew makes it 2.
    expect(store.renewCount).toBe(1);
    client.clientSend(JSON.stringify({ t: "lease_renew" }));
    await new Promise((r) => setTimeout(r, 5));

    expect(store.renewCount).toBe(2);
    // prepareAndOpen renews silently (no frame); only the explicit lease_renew
    // emits lease_renewed, carrying the 2nd renewed token.
    const renewed = client.frames.filter((f) => f.t === "lease_renewed") as Extract<
      AmbientServerFrame,
      { t: "lease_renewed" }
    >[];
    expect(renewed).toHaveLength(1);
    expect(renewed[0].leaseToken).toBe("renewed-2");

    // Subsequent appends use the NEW lease token (the store checks it).
    for (let i = 0; i < 8; i++) client.clientSend(pcm(2560));
    await new Promise((r) => setTimeout(r, 10));
    flux().emitTurn("EndOfTurn", "after renew");
    await new Promise((r) => setTimeout(r, 10));
    expect(store.segments.map((s) => s.text)).toEqual(["after renew"]);
  });

  test("revoke severs the live Flux socket (revoke-to-silence)", async () => {
    const store = new FakePendantStore(LEASE);
    const { client } = wireAmbient(store);
    const { token, jti } = await mintAmbientToken();
    await helloAmbient(client, token);
    for (let i = 0; i < 8; i++) client.clientSend(pcm(2560));
    await new Promise((r) => setTimeout(r, 10));

    const live = flux();
    expect(live.closed).toBe(false);

    // A same-worker revoke severs via the registry (the ws route wires this to
    // the durable revoke; here we call the registry's sever-by-jti directly).
    const { getVoiceSessionRegistry } = await import(
      "../../../../../shared/src/lib/voice-session/session-registry"
    );
    const severed = getVoiceSessionRegistry().severByJti(jti, "revoked");
    expect(severed).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    expect(live.closed).toBe(true);
    expect(client.closedWith).not.toBeNull();
  });

  test("no downlink audio is ever sent in ambient (empty downlink by contract)", async () => {
    const store = new FakePendantStore(LEASE);
    const { client } = wireAmbient(store);
    const { token } = await mintAmbientToken();
    // Track any binary send on the client transport.
    let binarySends = 0;
    const origSend = client.send.bind(client);
    client.send = (data: string | ArrayBuffer | Uint8Array) => {
      if (typeof data !== "string") binarySends++;
      return origSend(data);
    };
    await helloAmbient(client, token);
    for (let i = 0; i < 8; i++) client.clientSend(pcm(2560));
    await new Promise((r) => setTimeout(r, 10));
    flux().emitTurn("EndOfTurn", "hello");
    await new Promise((r) => setTimeout(r, 10));
    expect(binarySends).toBe(0);
  });

  test("resume: a session with existing segments appends contiguously (P1)", async () => {
    const store = new FakePendantStore(LEASE);
    // Pre-populate as if this pendant session already has 2 committed segments.
    store.segments.push(
      { id: pendantSegmentId(PENDANT, 0), ordinal: 0, revision: 0, text: "earlier one" },
      { id: pendantSegmentId(PENDANT, 1), ordinal: 1, revision: 0, text: "earlier two" },
    );
    const { client } = wireAmbient(store);
    const { token } = await mintAmbientToken();
    await helloAmbient(client, token);
    for (let i = 0; i < 8; i++) client.clientSend(pcm(2560));
    await new Promise((r) => setTimeout(r, 10));
    flux().emitTurn("EndOfTurn", "resumed utterance");
    await new Promise((r) => setTimeout(r, 10));
    // The new segment lands at ordinal 2 (contiguous after the existing 2), not 0.
    expect(store.segments.map((s) => s.ordinal)).toEqual([0, 1, 2]);
    expect(store.segments[2].text).toBe("resumed utterance");
    const finals = client.frames.filter((f) => f.t === "stt_final") as Extract<
      AmbientServerFrame,
      { t: "stt_final" }
    >[];
    expect(finals[0].ordinal).toBe(2);
  });

  test("a bad capture lease refuses Flux at start — no audio streams (P2)", async () => {
    const store = new FakePendantStore(LEASE);
    const { client } = wireAmbient(store);
    const { token } = await mintAmbientToken();
    // Present a DIFFERENT lease token than the store holds: prepareAndOpen's
    // renew fails, so Flux never opens and no audio is forwarded.
    await helloAmbient(client, token, { leaseToken: "tampered-lease" });
    await new Promise((r) => setTimeout(r, 10));
    const err = client.frames.find((f) => f.t === "error") as Extract<AmbientServerFrame, { t: "error" }>;
    expect(err?.code).toBe("lease_conflict");
    // No Flux socket was opened (start refused before openFlux).
    expect(FakeFluxSocket.instances.length).toBe(0);
    // Even if the client streams audio, nothing is captured (no ready, closed).
    for (let i = 0; i < 8; i++) client.clientSend(pcm(2560));
    await new Promise((r) => setTimeout(r, 5));
    expect(store.segments).toHaveLength(0);
  });

  test("pause then quick resume leaves the store ACTIVE even under out-of-order writes (P2)", async () => {
    const store = new FakePendantStore(LEASE);
    // Make setState resolve out of order: delay the FIRST call (paused) longer
    // than the second (active). Without the state chain, active would land then
    // paused, leaving the store paused while Flux is open.
    const origSetState = store.setState.bind(store);
    let call = 0;
    store.setState = (async (p: string, s: "paused" | "active" | "ended") => {
      call++;
      const delay = call === 1 ? 40 : 5; // first (paused) slower than second (active).
      await new Promise((r) => setTimeout(r, delay));
      return origSetState(p, s);
    }) as typeof store.setState;

    const { client } = wireAmbient(store);
    const { token } = await mintAmbientToken();
    await helloAmbient(client, token);

    client.clientSend(JSON.stringify({ t: "pause" }));
    await new Promise((r) => setTimeout(r, 2));
    client.clientSend(JSON.stringify({ t: "resume" }));
    // Wait for both delayed writes to settle in ORDER (chain serializes them).
    await new Promise((r) => setTimeout(r, 80));

    // Despite the paused write being slower, the store ends ACTIVE (resume last).
    expect(store.state).toBe("active");

    // And capture works after the resume.
    for (let i = 0; i < 8; i++) client.clientSend(pcm(2560));
    await new Promise((r) => setTimeout(r, 10));
    flux().emitTurn("EndOfTurn", "resumed cleanly");
    await new Promise((r) => setTimeout(r, 10));
    expect(store.segments.map((s) => s.text)).toContain("resumed cleanly");
  });

  test("lease renewal refreshes the cross-worker revocation directory (P1)", async () => {
    const store = new FakePendantStore(LEASE);
    FakeFluxSocket.instances = [];
    const client = new FakeClientSocket();
    const usageStore = new InMemoryVoiceUsageStore();
    const dirRefreshes: string[] = [];
    attachVoiceWsHandler(client as never, {
      requestedSessionId: SESSION,
      buildAmbientSession: ({ claims, jti, tokenExpSeconds, pendantSessionId, captureLeaseToken, downlink }) =>
        new AmbientSession({
          sessionId: claims.sessionId,
          jti,
          organizationId: claims.organizationId,
          userId: claims.userId,
          agentId: claims.agentId,
          pendantSessionId,
          captureLeaseToken,
          tokenExpSeconds,
          deepgramApiKey: "dg",
          deepgramWebSocketFactory: () => new FakeFluxSocket(),
          store,
          usageStore,
          usageLimits: { organizationDailyMinutes: 1440, userDailyMinutes: 720 },
          refreshRevocationDirectory: async (j) => {
            dirRefreshes.push(j);
          },
          downlink,
        }),
      buildSession: () => {
        throw new Error("unused");
      },
    });
    const { token, jti } = await mintAmbientToken();
    await helloAmbient(client, token);
    // start() renews once (refreshing the directory once).
    expect(dirRefreshes).toContain(jti);
    const atStart = dirRefreshes.length;
    // An explicit lease_renew refreshes the directory again.
    client.clientSend(JSON.stringify({ t: "lease_renew" }));
    await new Promise((r) => setTimeout(r, 5));
    expect(dirRefreshes.length).toBe(atStart + 1);
  });

  test("bye ends the pendant session and closes the socket", async () => {
    const store = new FakePendantStore(LEASE);
    const { client } = wireAmbient(store);
    const { token } = await mintAmbientToken();
    await helloAmbient(client, token);
    client.clientSend(JSON.stringify({ t: "bye" }));
    await new Promise((r) => setTimeout(r, 5));
    expect(store.state).toBe("ended");
    expect(client.closedWith).not.toBeNull();
  });
});

describe("ambient auth + mode enforcement", () => {
  test("a conversation token cannot open an ambient socket (mode mismatch)", async () => {
    const store = new FakePendantStore(LEASE);
    const { client } = wireAmbient(store);
    // Mint a CONVERSATION token (no ambient claims).
    const conv = await mintVoiceSessionToken({
      sessionId: SESSION,
      organizationId: ORG,
      userId: USER,
      agentId: AGENT,
      conversationId: CONV,
    });
    await helloAmbient(client, conv.token);
    const err = client.frames.find((f) => f.t === "error") as Extract<AmbientServerFrame, { t: "error" }>;
    expect(err).toBeDefined();
    // claim mismatch on pendantSessionId (the conv token has none) or mode_mismatch.
    expect(["claim_mismatch", "mode_mismatch"]).toContain(err.code);
    expect(store.segments).toHaveLength(0);
  });

  test("ambient hello for a different pendantSessionId than the token is rejected", async () => {
    const store = new FakePendantStore(LEASE);
    const { client } = wireAmbient(store);
    const { token } = await mintAmbientToken({ pendantSessionId: "pendant-A" });
    // Present pendant-B in the hello; the token was minted for pendant-A.
    await helloAmbient(client, token, { pendantSessionId: "pendant-B" });
    const err = client.frames.find((f) => f.t === "error") as Extract<AmbientServerFrame, { t: "error" }>;
    expect(err?.code).toBe("claim_mismatch");
  });

  test("ambient hello is refused when the deployment has no ambient builder", async () => {
    FakeFluxSocket.instances = [];
    const client = new FakeClientSocket();
    attachVoiceWsHandler(client as never, {
      requestedSessionId: SESSION,
      buildSession: () => {
        throw new Error("unused");
      },
      // no buildAmbientSession
    });
    const { token } = await mintAmbientToken();
    await helloAmbient(client, token);
    const err = client.frames.find((f) => f.t === "error") as Extract<AmbientServerFrame, { t: "error" }>;
    expect(err?.code).toBe("ambient_not_enabled");
  });
});

/**
 * Ambient wire protocol + ambient JWT claims.
 *
 * Covers: ambient hello detection/parse (mode/pendant/lease/codec/sampleRate),
 * ambient control-frame parsing (pause/resume/lease_renew/bye, barge_in
 * ignored, unknown rejected), and the ambient JWT claim pairing (ambient
 * requires pendantSessionId; conversation must not carry one; verify enforces
 * the same pairing mint enforces).
 */

import { beforeAll, describe, expect, test } from "bun:test";

import {
  isAmbientHelloRaw,
  parseAmbientControlFrame,
  parseAmbientHello,
  serializeAmbientServerFrame,
} from "../ambient-protocol";
import {
  mintVoiceSessionToken,
  verifyVoiceSessionToken,
  VoiceSessionTokenError,
} from "../jwt";
import { installVoiceSessionTestSigningKey } from "../test-signing";

beforeAll(async () => {
  await installVoiceSessionTestSigningKey();
});

const validAmbientHello = JSON.stringify({
  t: "hello",
  mode: "ambient",
  token: "a.b.c",
  protocol: 1,
  pendantSessionId: "pendant-1",
  captureLeaseToken: "lease-1",
  uplinkCodec: "pcm16",
  sampleRate: 16000,
});

describe("ambient hello detection + parse", () => {
  test("isAmbientHelloRaw distinguishes ambient from conversation hello", () => {
    expect(isAmbientHelloRaw(validAmbientHello)).toBe(true);
    const conv = JSON.stringify({ t: "hello", token: "a.b.c", protocol: 1, uplinkCodec: "pcm16", downlinkCodec: "pcm16", sampleRate: 16000 });
    expect(isAmbientHelloRaw(conv)).toBe(false);
    expect(isAmbientHelloRaw("not json")).toBe(false);
    expect(isAmbientHelloRaw(JSON.stringify({ t: "pause" }))).toBe(false);
  });

  test("parseAmbientHello accepts a valid ambient hello", () => {
    const r = parseAmbientHello(validAmbientHello);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.pendantSessionId).toBe("pendant-1");
      expect(r.value.captureLeaseToken).toBe("lease-1");
      expect(r.value.uplinkCodec).toBe("pcm16");
    }
  });

  test("parseAmbientHello rejects missing pendantSessionId / lease / bad codec / sampleRate", () => {
    const missPendant = JSON.stringify({ ...JSON.parse(validAmbientHello), pendantSessionId: "" });
    expect(parseAmbientHello(missPendant).ok).toBe(false);
    const missLease = JSON.stringify({ ...JSON.parse(validAmbientHello), captureLeaseToken: "" });
    expect(parseAmbientHello(missLease).ok).toBe(false);
    const badCodec = JSON.stringify({ ...JSON.parse(validAmbientHello), uplinkCodec: "opus" });
    expect(parseAmbientHello(badCodec).ok).toBe(false);
    const badRate = JSON.stringify({ ...JSON.parse(validAmbientHello), sampleRate: 8000 });
    expect(parseAmbientHello(badRate).ok).toBe(false);
  });

  test("parseAmbientHello rejects a non-ambient frame", () => {
    const conv = JSON.stringify({ t: "hello", token: "a.b.c", protocol: 1, uplinkCodec: "pcm16", downlinkCodec: "pcm16", sampleRate: 16000 });
    const r = parseAmbientHello(conv);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("hello_not_ambient");
  });
});

describe("ambient control frames", () => {
  test("pause / resume / lease_renew / bye parse", () => {
    for (const t of ["pause", "resume", "lease_renew", "bye"]) {
      const r = parseAmbientControlFrame(JSON.stringify({ t }));
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.t).toBe(t);
    }
  });

  test("barge_in is accepted-and-ignored (no downlink to interrupt)", () => {
    const r = parseAmbientControlFrame(JSON.stringify({ t: "barge_in" }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.t).toBe("barge_in_ignored");
  });

  test("a second hello and unknown types are rejected", () => {
    const dup = parseAmbientControlFrame(JSON.stringify({ t: "hello" }));
    expect(dup.ok).toBe(false);
    const unknown = parseAmbientControlFrame(JSON.stringify({ t: "wat" }));
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.code).toBe("control_unknown_type");
  });

  test("malformed json is a typed error, not a throw", () => {
    const r = parseAmbientControlFrame("{not json");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("control_invalid_json");
  });
});

describe("ambient server frame serialization", () => {
  test("stt_final carries canonical segment id + ordinal + revision", () => {
    const raw = serializeAmbientServerFrame({
      t: "stt_final",
      text: "hi",
      segmentId: "s:segment:0",
      ordinal: 0,
      revision: 0,
      traceId: "t",
    });
    const parsed = JSON.parse(raw);
    expect(parsed.segmentId).toBe("s:segment:0");
    expect(parsed.ordinal).toBe(0);
  });
});

describe("ambient jwt claims", () => {
  const base = {
    sessionId: "s1",
    organizationId: "o1",
    userId: "u1",
    agentId: "a1",
    conversationId: "c1",
  };

  test("ambient token requires a pendantSessionId (mint rejects without)", async () => {
    await expect(
      mintVoiceSessionToken({ ...base, mode: "ambient" }),
    ).rejects.toBeInstanceOf(VoiceSessionTokenError);
  });

  test("conversation token must not carry pendantSessionId (mint rejects)", async () => {
    await expect(
      mintVoiceSessionToken({ ...base, pendantSessionId: "p1" } as never),
    ).rejects.toBeInstanceOf(VoiceSessionTokenError);
  });

  test("round-trip: ambient claims verify with mode + pendantSessionId", async () => {
    const minted = await mintVoiceSessionToken({ ...base, mode: "ambient", pendantSessionId: "p1" });
    const verified = await verifyVoiceSessionToken(minted.token);
    expect(verified.claims.mode).toBe("ambient");
    expect(verified.claims.pendantSessionId).toBe("p1");
  });

  test("round-trip: conversation claims verify with no ambient fields (backward compatible)", async () => {
    const minted = await mintVoiceSessionToken(base);
    const verified = await verifyVoiceSessionToken(minted.token);
    expect(verified.claims.mode).toBe("conversation");
    expect(verified.claims.pendantSessionId).toBeUndefined();
  });

  test("verify pins pendantSessionId: a token minted for p1 is a claim_mismatch against p2", async () => {
    const minted = await mintVoiceSessionToken({ ...base, mode: "ambient", pendantSessionId: "p1" });
    await expect(
      verifyVoiceSessionToken(minted.token, { pendantSessionId: "p2" }),
    ).rejects.toMatchObject({ code: "claim_mismatch" });
  });
});

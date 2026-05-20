import { describe, expect, it, vi } from "vitest";

import {
  VoiceProfilesClient,
  VoiceProfilesUnavailableError,
} from "./client-voice-profiles";

function makeClient(
  fetchImpl: (path: string, init?: RequestInit) => Promise<unknown>,
) {
  return new VoiceProfilesClient({
    fetch: (path: string, init?: RequestInit) =>
      fetchImpl(path, init) as Promise<never>,
  });
}

describe("VoiceProfilesClient.list", () => {
  it("returns normalised profiles from the server", async () => {
    const client = makeClient(async (path) => {
      expect(path).toBe("/api/voice/profiles");
      return {
        profiles: [
          {
            id: "owner-1",
            displayName: "Shaw",
            isOwner: true,
            entityId: "ent-shaw",
            embeddingCount: 4,
            firstHeardAtMs: 1,
            lastHeardAtMs: 2,
            cohort: "owner",
            source: "onboarding",
          },
        ],
      };
    });

    const list = await client.list();
    expect(list).toHaveLength(1);
    const owner = list[0];
    expect(owner).toBeDefined();
    if (!owner) throw new Error("missing owner");
    expect(owner.id).toBe("owner-1");
    expect(owner.isOwner).toBe(true);
    expect(owner.entityId).toBe("ent-shaw");
    expect(owner.cohort).toBe("owner");
    expect(owner.source).toBe("onboarding");
  });

  it("falls back to [] when the endpoint is missing (404)", async () => {
    const client = makeClient(async () => {
      throw Object.assign(new Error("Not found"), { status: 404 });
    });
    expect(await client.list()).toEqual([]);
  });

  it("throws VoiceProfilesUnavailableError for unexpected errors", async () => {
    const client = makeClient(async () => {
      throw Object.assign(new Error("boom"), { status: 500 });
    });
    await expect(client.list()).rejects.toBeInstanceOf(
      VoiceProfilesUnavailableError,
    );
  });

  it("accepts a raw array response", async () => {
    const client = makeClient(async () => [
      {
        id: "p1",
        displayName: "Jill",
        isOwner: false,
        embeddingCount: 2,
        firstHeardAtMs: 0,
        lastHeardAtMs: 0,
        cohort: "family",
        source: "auto-clustered",
        relationshipLabel: "wife",
      },
    ]);
    const list = await client.list();
    expect(list).toHaveLength(1);
    const jill = list[0];
    if (!jill) throw new Error("missing jill");
    expect(jill.relationshipLabel).toBe("wife");
    expect(jill.cohort).toBe("family");
  });

  it("filters out malformed entries", async () => {
    const client = makeClient(async () => ({
      profiles: [
        { id: "good" },
        { notAnId: true }, // missing id → dropped
        null,
      ],
    }));
    const list = await client.list();
    expect(list).toHaveLength(1);
  });
});

describe("VoiceProfilesClient.startOwnerCapture", () => {
  it("returns the server session when available", async () => {
    const client = makeClient(async () => ({
      sessionId: "real-session",
      prompts: [{ id: "p1", text: "Say hi", targetSeconds: 5 }],
      expectedSeconds: 5,
    }));
    const session = await client.startOwnerCapture();
    expect(session.sessionId).toBe("real-session");
    expect(session.prompts).toHaveLength(1);
  });

  it("falls back to local prompts when the endpoint is missing", async () => {
    const client = makeClient(async () => {
      throw Object.assign(new Error("not found"), { status: 404 });
    });
    const session = await client.startOwnerCapture();
    expect(session.sessionId.startsWith("local-")).toBe(true);
    expect(session.prompts.length).toBeGreaterThanOrEqual(2);
    expect(session.expectedSeconds).toBeGreaterThan(0);
  });

  it("falls back to local prompts when a mobile shell returns a non-JSON route response", async () => {
    const client = makeClient(async () => {
      throw Object.assign(new Error("Invalid JSON response: <html>"), {
        kind: "parse",
      });
    });
    const session = await client.startOwnerCapture();
    expect(session.sessionId.startsWith("local-")).toBe(true);
    expect(session.prompts.length).toBeGreaterThanOrEqual(2);
  });

  it("normalises the local-inference route script response", async () => {
    const client = makeClient(async () => ({
      sessionId: "voice-session",
      script: [
        {
          id: "calibration",
          prompt: "Please say your name.",
          expectedDurationMs: 5000,
        },
      ],
      embeddingModel: "wespeaker",
    }));

    const session = await client.startOwnerCapture();
    expect(session.sessionId).toBe("voice-session");
    expect(session.prompts).toEqual([
      { id: "calibration", text: "Please say your name.", targetSeconds: 5 },
    ]);
    expect(session.expectedSeconds).toBe(5);
  });

  it("falls back to local prompts when the route returns an incompatible shape", async () => {
    const client = makeClient(async () => ({
      sessionId: "voice-session",
      script: [],
    }));

    const session = await client.startOwnerCapture();
    expect(session.sessionId.startsWith("local-")).toBe(true);
    expect(session.prompts.length).toBeGreaterThanOrEqual(2);
  });
});

describe("VoiceProfilesClient.appendOwnerCapture", () => {
  it("uses the local-inference id query parameter", async () => {
    const calls: string[] = [];
    const client = makeClient(async (path) => {
      calls.push(path);
      return {};
    });

    await client.appendOwnerCapture("session-x", {
      promptId: "p1",
      audioBase64: "AAAA",
      durationMs: 1000,
    });

    expect(calls).toEqual([
      "/api/voice/onboarding/profile/append?id=session-x",
    ]);
  });

  it("does not block onboarding when the route rejects the temporary JSON capture body", async () => {
    const client = makeClient(async () => {
      throw Object.assign(new Error("invalid PCM body"), {
        kind: "http",
        status: 400,
      });
    });

    await expect(
      client.appendOwnerCapture("session-x", {
        promptId: "p1",
        audioBase64: "AAAA",
        durationMs: 1000,
      }),
    ).resolves.toBeUndefined();
  });

  it("falls back to local prompts when the endpoint returns a partial session", async () => {
    const client = makeClient(async () => ({
      sessionId: "partial-session",
    }));
    const session = await client.startOwnerCapture();
    expect(session.sessionId.startsWith("local-")).toBe(true);
    expect(session.prompts.length).toBeGreaterThanOrEqual(2);
    expect(session.expectedSeconds).toBeGreaterThan(0);
  });

  it("normalises malformed prompts instead of returning an unsafe session", async () => {
    const client = makeClient(async () => ({
      sessionId: "mixed-session",
      prompts: [
        { id: "valid", text: "Say a short phrase" },
        { id: "bad" },
        null,
      ],
    }));
    const session = await client.startOwnerCapture();
    expect(session.sessionId).toBe("mixed-session");
    expect(session.prompts).toEqual([
      { id: "valid", text: "Say a short phrase", targetSeconds: 5 },
    ]);
    expect(session.expectedSeconds).toBe(5);
  });
});

describe("VoiceProfilesClient.finalizeOwnerCapture", () => {
  it("returns the deterministic OWNER fallback when the endpoint is missing", async () => {
    const client = makeClient(async () => {
      throw Object.assign(new Error("connection refused"), {});
    });
    const r = await client.finalizeOwnerCapture("session-x", {
      displayName: "Shaw",
    });
    expect(r.isOwner).toBe(true);
    expect(r.profileId).toContain("session-x");
    expect(r.entityId).toContain("session-x");
  });

  it("uses the local-inference id query parameter when finalizing", async () => {
    const calls: string[] = [];
    const client = makeClient(async (path) => {
      calls.push(path);
      return {
        profileId: "profile-x",
        entityId: "entity-x",
        isOwner: true,
      };
    });

    await client.finalizeOwnerCapture("session-x", { displayName: "Shaw" });

    expect(calls).toEqual([
      "/api/voice/onboarding/profile/finalize?id=session-x",
    ]);
  });

  it("returns the deterministic OWNER fallback when no embeddings are captured yet", async () => {
    const client = makeClient(async () => {
      throw Object.assign(new Error("no embeddings captured yet"), {
        kind: "http",
        status: 400,
      });
    });

    const r = await client.finalizeOwnerCapture("session-x", {
      displayName: "Shaw",
    });

    expect(r.isOwner).toBe(true);
    expect(r.profileId).toContain("session-x");
  });
});

describe("VoiceProfilesClient mutations swallow missing-endpoint errors", () => {
  const cases: Array<[string, (c: VoiceProfilesClient) => Promise<unknown>]> = [
    ["patch", (c) => c.patch("a", { displayName: "x" })],
    ["merge", (c) => c.merge("a", { intoId: "b" })],
    ["split", (c) => c.split("a", { utteranceIds: ["u1"] })],
    ["delete", (c) => c.delete("a")],
    ["deleteAll", (c) => c.deleteAll()],
  ];

  for (const [name, run] of cases) {
    it(`${name}: returns without throwing on 404`, async () => {
      const client = makeClient(async () => {
        throw Object.assign(new Error("not found"), { status: 404 });
      });
      await run(client); // should not throw
    });

    it(`${name}: surfaces non-404 failures`, async () => {
      const spy = vi.fn(async () => {
        throw Object.assign(new Error("boom"), { status: 500 });
      });
      const client = makeClient(spy);
      await expect(run(client)).rejects.toBeInstanceOf(
        VoiceProfilesUnavailableError,
      );
    });
  }
});

describe("VoiceProfilesClient.exportAll", () => {
  it("returns null downloadUrl on the missing endpoint fallback", async () => {
    const client = makeClient(async () => {
      throw Object.assign(new Error("not found"), { status: 404 });
    });
    const r = await client.exportAll();
    expect(r.downloadUrl).toBeNull();
  });
});

import { describe, expect, it, vi } from "vitest";

import {
  VoiceProfilesClient,
  VoiceProfilesUnavailableError,
} from "./client-voice-profiles";

function makeClient(fetchImpl: (path: string) => Promise<unknown>) {
  return new VoiceProfilesClient({
    fetch: (path: string) => fetchImpl(path) as Promise<never>,
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

import { describe, expect, it } from "vitest";

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

  it("surfaces failures instead of fabricating an empty list", async () => {
    const client = makeClient(async () => {
      throw Object.assign(new Error("Not found"), { status: 404 });
    });
    await expect(client.list()).rejects.toBeInstanceOf(
      VoiceProfilesUnavailableError,
    );
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

  it("surfaces failures instead of fabricating a local session", async () => {
    const client = makeClient(async () => {
      throw Object.assign(new Error("not found"), { status: 404 });
    });
    await expect(client.startOwnerCapture()).rejects.toBeInstanceOf(
      VoiceProfilesUnavailableError,
    );
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

  it("rejects a server response missing a sessionId", async () => {
    const client = makeClient(async () => ({
      prompts: [{ id: "p1", text: "Say hi", targetSeconds: 5 }],
    }));
    await expect(client.startOwnerCapture()).rejects.toBeInstanceOf(
      VoiceProfilesUnavailableError,
    );
  });

  it("rejects a server response with no usable prompts", async () => {
    const client = makeClient(async () => ({
      sessionId: "voice-session",
      script: [],
    }));
    await expect(client.startOwnerCapture()).rejects.toBeInstanceOf(
      VoiceProfilesUnavailableError,
    );
  });

  it("normalises malformed prompts and keeps only valid ones", async () => {
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

  it("surfaces a rejected capture body instead of swallowing it", async () => {
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
    ).rejects.toBeInstanceOf(VoiceProfilesUnavailableError);
  });
});

describe("VoiceProfilesClient.finalizeOwnerCapture", () => {
  it("returns the server result", async () => {
    const calls: string[] = [];
    const client = makeClient(async (path) => {
      calls.push(path);
      return {
        profileId: "profile-x",
        entityId: "entity-x",
        isOwner: true,
      };
    });

    const r = await client.finalizeOwnerCapture("session-x", {
      displayName: "Shaw",
    });

    expect(r.profileId).toBe("profile-x");
    expect(r.isOwner).toBe(true);
    expect(calls).toEqual([
      "/api/voice/onboarding/profile/finalize?id=session-x",
    ]);
  });

  it("surfaces failures instead of fabricating an OWNER result", async () => {
    const client = makeClient(async () => {
      throw Object.assign(new Error("no embeddings captured yet"), {
        kind: "http",
        status: 400,
      });
    });

    await expect(
      client.finalizeOwnerCapture("session-x", { displayName: "Shaw" }),
    ).rejects.toBeInstanceOf(VoiceProfilesUnavailableError);
  });
});

describe("VoiceProfilesClient.captureFamilyMember", () => {
  it("returns the server result", async () => {
    const client = makeClient(async (path) => {
      expect(path).toBe("/v1/voice/onboarding/family-member");
      return {
        profileId: "vp_abc",
        entityId: "ent-fam",
        displayName: "Alex",
        relationship: "spouse",
        relationshipTag: "family_of",
        ownerEntityId: "ent-owner",
      };
    });

    const r = await client.captureFamilyMember({
      audioBase64: "dGVzdA==",
      durationMs: 5000,
      displayName: "Alex",
      relationship: "spouse",
    });
    expect(r.profileId).toBe("vp_abc");
    expect(r.entityId).toBe("ent-fam");
  });

  it("surfaces failures instead of fabricating a stub result", async () => {
    const client = makeClient(async () => {
      throw Object.assign(new Error("not found"), { status: 404 });
    });

    await expect(
      client.captureFamilyMember({
        audioBase64: "dGVzdA==",
        durationMs: 5000,
        displayName: "Test",
        relationship: "family",
      }),
    ).rejects.toBeInstanceOf(VoiceProfilesUnavailableError);
  });
});

describe("VoiceProfilesClient mutations surface failures", () => {
  const cases: Array<[string, (c: VoiceProfilesClient) => Promise<unknown>]> = [
    ["patch", (c) => c.patch("a", { displayName: "x" })],
    ["merge", (c) => c.merge("a", { intoId: "b" })],
    ["split", (c) => c.split("a", { utteranceIds: ["u1"] })],
    ["delete", (c) => c.delete("a")],
    ["deleteAll", (c) => c.deleteAll()],
  ];

  for (const [name, run] of cases) {
    it(`${name}: surfaces a 404 instead of swallowing it`, async () => {
      const client = makeClient(async () => {
        throw Object.assign(new Error("not found"), { status: 404 });
      });
      await expect(run(client)).rejects.toBeInstanceOf(
        VoiceProfilesUnavailableError,
      );
    });

    it(`${name}: surfaces non-404 failures`, async () => {
      const client = makeClient(async () => {
        throw Object.assign(new Error("boom"), { status: 500 });
      });
      await expect(run(client)).rejects.toBeInstanceOf(
        VoiceProfilesUnavailableError,
      );
    });
  }
});

describe("VoiceProfilesClient.exportAll", () => {
  it("returns the server download URL", async () => {
    const client = makeClient(async () => ({
      downloadUrl: "https://example.com/export.json",
    }));
    const r = await client.exportAll();
    expect(r.downloadUrl).toBe("https://example.com/export.json");
  });

  it("surfaces failures instead of fabricating a null URL", async () => {
    const client = makeClient(async () => {
      throw Object.assign(new Error("not found"), { status: 404 });
    });
    await expect(client.exportAll()).rejects.toBeInstanceOf(
      VoiceProfilesUnavailableError,
    );
  });
});

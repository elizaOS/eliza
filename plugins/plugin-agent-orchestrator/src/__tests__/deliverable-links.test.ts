/**
 * Deliverable-URL canonicalization: the pure rewriter
 * (canonicalizeDeliverableUrls), the ELIZA_DELIVERABLE_URL_REWRITES config
 * reader (malformed config degrades to no rewrites, never a throw), and the
 * swarm-coordinator call site — a relayed completion narrating a hosting
 * provider's origin host must reach the synthesis callback carrying the
 * canonical custom-domain URL. Deterministic harness: real
 * SwarmCoordinatorService bound to a fake ACP event stream; only the ACP
 * surface and runtime settings are faked.
 */

import { describe, expect, it, vi } from "vitest";
import { AcpService } from "../services/acp-service.ts";
import {
  canonicalizeDeliverableUrls,
  canonicalizeDeliverableUrlsForRuntime,
  parseDeliverableUrlRewrites,
  readDeliverableUrlRewrites,
} from "../services/deliverable-links.ts";
import { SwarmCoordinatorService } from "../services/swarm-coordinator-service.ts";

const REWRITES = { "agent-home.vercel.app": "nubilio.org" };

describe("canonicalizeDeliverableUrls", () => {
  it("rewrites an exact-host match, preserving path, query, and fragment", () => {
    expect(
      canonicalizeDeliverableUrls(
        "Done. Live at https://agent-home.vercel.app/apps/pomodoro-timer-2?tab=stats#top — enjoy.",
        REWRITES,
      ),
    ).toBe(
      "Done. Live at https://nubilio.org/apps/pomodoro-timer-2?tab=stats#top — enjoy.",
    );
  });

  it("leaves a non-matching host untouched byte-for-byte", () => {
    const text =
      "See https://other-app.vercel.app/apps/x and http://example.org/y?a=1.";
    expect(canonicalizeDeliverableUrls(text, REWRITES)).toBe(text);
  });

  it("rewrites every matching URL in a multi-URL text, leaving the rest alone", () => {
    expect(
      canonicalizeDeliverableUrls(
        "Page: https://agent-home.vercel.app/apps/a — API: https://api.example.com/v1 — again http://agent-home.vercel.app/apps/b.",
        REWRITES,
      ),
    ).toBe(
      "Page: https://nubilio.org/apps/a — API: https://api.example.com/v1 — again http://nubilio.org/apps/b.",
    );
  });

  it("keeps the scheme as-is and drops the port when the host is rewritten", () => {
    expect(
      canonicalizeDeliverableUrls(
        "http://agent-home.vercel.app:8443/apps/x",
        REWRITES,
      ),
    ).toBe("http://nubilio.org/apps/x");
  });

  it("matches the host case-insensitively", () => {
    expect(
      canonicalizeDeliverableUrls(
        "https://Agent-Home.VERCEL.app/apps/x",
        REWRITES,
      ),
    ).toBe("https://nubilio.org/apps/x");
  });

  it("does not touch a matching host under a non-http(s) scheme or in bare prose", () => {
    const text = "ftp://agent-home.vercel.app/x and bare agent-home.vercel.app";
    expect(canonicalizeDeliverableUrls(text, REWRITES)).toBe(text);
  });

  it("does not rewrite a subdomain or superstring of a configured host", () => {
    const text =
      "https://sub.agent-home.vercel.app/x https://agent-home.vercel.app.evil.example/x";
    expect(canonicalizeDeliverableUrls(text, REWRITES)).toBe(text);
  });

  it("is the identity with an empty rewrites map", () => {
    const text = "https://agent-home.vercel.app/apps/x";
    expect(canonicalizeDeliverableUrls(text, {})).toBe(text);
  });

  it("preserves a root-anchored trailing dot instead of eating punctuation", () => {
    expect(
      canonicalizeDeliverableUrls("https://agent-home.vercel.app.", REWRITES),
    ).toBe("https://nubilio.org.");
  });

  it("structurally drops a rewrite whose replacement is not a bare host", () => {
    const text = "https://agent-home.vercel.app/apps/x";
    expect(
      canonicalizeDeliverableUrls(text, {
        "agent-home.vercel.app": "https://nubilio.org/evil",
      }),
    ).toBe(text);
  });
});

describe("parseDeliverableUrlRewrites", () => {
  it("parses a valid host → host object, lowercasing keys", () => {
    expect(
      parseDeliverableUrlRewrites(
        '{"Agent-Home.Vercel.app":"nubilio.org","b.example":"c.example"}',
      ),
    ).toEqual({
      "agent-home.vercel.app": "nubilio.org",
      "b.example": "c.example",
    });
  });

  it("returns no rewrites for malformed JSON without throwing", () => {
    expect(parseDeliverableUrlRewrites("{not json")).toEqual({});
  });

  it("returns no rewrites for a non-object JSON root", () => {
    expect(parseDeliverableUrlRewrites('["agent-home.vercel.app"]')).toEqual(
      {},
    );
    expect(parseDeliverableUrlRewrites('"nubilio.org"')).toEqual({});
  });

  it("drops structurally invalid entries but keeps valid ones", () => {
    expect(
      parseDeliverableUrlRewrites(
        '{"agent-home.vercel.app":"nubilio.org","bad host":"x.example","also.bad":42}',
      ),
    ).toEqual({ "agent-home.vercel.app": "nubilio.org" });
  });

  it("treats an empty/absent value as unconfigured", () => {
    expect(parseDeliverableUrlRewrites(undefined)).toEqual({});
    expect(parseDeliverableUrlRewrites("   ")).toEqual({});
  });
});

describe("readDeliverableUrlRewrites / canonicalizeDeliverableUrlsForRuntime", () => {
  const runtimeWithSetting = (value: string) =>
    ({
      getSetting: (key: string) =>
        key === "ELIZA_DELIVERABLE_URL_REWRITES" ? value : undefined,
    }) as never;

  it("reads the map from runtime.getSetting", () => {
    expect(
      readDeliverableUrlRewrites(runtimeWithSetting(JSON.stringify(REWRITES))),
    ).toEqual(REWRITES);
  });

  it("degrades malformed runtime config to a pass-through, never a throw", () => {
    const text = "Live at https://agent-home.vercel.app/apps/x";
    expect(
      canonicalizeDeliverableUrlsForRuntime(
        runtimeWithSetting("{broken json"),
        text,
      ),
    ).toBe(text);
  });

  it("canonicalizes with a valid runtime config", () => {
    expect(
      canonicalizeDeliverableUrlsForRuntime(
        runtimeWithSetting(JSON.stringify(REWRITES)),
        "Live at https://agent-home.vercel.app/apps/x",
      ),
    ).toBe("Live at https://nubilio.org/apps/x");
  });
});

type EventHandler = (sessionId: string, event: string, data: unknown) => void;

class FakeAcp {
  static serviceType = AcpService.serviceType;
  readonly metadataById = new Map<string, Record<string, unknown>>();
  private handler: EventHandler | undefined;

  async getSession(id: string) {
    const metadata = this.metadataById.get(id);
    if (!metadata) return undefined;
    return { id, status: "ready", metadata };
  }

  async updateSessionMetadata(
    id: string,
    patch: Record<string, unknown>,
  ): Promise<void> {
    const current = this.metadataById.get(id) ?? {};
    this.metadataById.set(id, { ...current, ...patch });
  }

  onSessionEvent(cb: EventHandler): () => void {
    this.handler = cb;
    return () => {
      this.handler = undefined;
    };
  }

  emit(sessionId: string, event: string, data: unknown = {}): void {
    this.handler?.(sessionId, event, data);
  }
}

function makeRuntime(
  acp: FakeAcp,
  rewritesSetting: string,
): Record<string, unknown> {
  return {
    agentId: "00000000-0000-4000-8000-000000000042",
    character: { name: "Coordinator" },
    reportError: vi.fn(),
    getSetting: (key: string) =>
      key === "ELIZA_DELIVERABLE_URL_REWRITES" ? rewritesSetting : undefined,
    getService: (type: string) =>
      type === AcpService.serviceType ? acp : undefined,
  };
}

async function settle(ms = 30): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function harness(rewritesSetting: string) {
  const acp = new FakeAcp();
  const service = await SwarmCoordinatorService.start(
    makeRuntime(acp, rewritesSetting) as never,
  );
  const completions: Array<{ sessionId: string; completionSummary: string }> =
    [];
  service.setSwarmCompleteCallback(async (payload) => {
    for (const task of payload.tasks) {
      completions.push({
        sessionId: task.sessionId,
        completionSummary: task.completionSummary,
      });
    }
  });
  return { acp, service, completions };
}

describe("swarm-coordinator completion relay canonicalizes deliverable URLs", () => {
  it("delivers the custom-domain URL to the callback when the child reported the origin host", async () => {
    const { acp, completions } = await harness(JSON.stringify(REWRITES));
    acp.metadataById.set("s-url", { label: "pomodoro-timer-2" });
    acp.emit("s-url", "task_complete", {
      label: "pomodoro-timer-2",
      response:
        "Build finished. Live at https://agent-home.vercel.app/apps/pomodoro-timer-2",
    });
    await settle();
    expect(completions).toHaveLength(1);
    expect(completions[0]?.completionSummary).toContain(
      "https://nubilio.org/apps/pomodoro-timer-2",
    );
    expect(completions[0]?.completionSummary).not.toContain(
      "agent-home.vercel.app",
    );
  });

  it("relays unchanged (and does not throw) when the configured map is malformed", async () => {
    const { acp, completions } = await harness("{definitely not json");
    acp.metadataById.set("s-bad", { label: "pomodoro-timer-2" });
    acp.emit("s-bad", "task_complete", {
      label: "pomodoro-timer-2",
      response:
        "Build finished. Live at https://agent-home.vercel.app/apps/pomodoro-timer-2",
    });
    await settle();
    expect(completions).toHaveLength(1);
    expect(completions[0]?.completionSummary).toContain(
      "https://agent-home.vercel.app/apps/pomodoro-timer-2",
    );
  });
});

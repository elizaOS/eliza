import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyPrivacyFilter,
  type FilterableTrajectory,
} from "../src/core/privacy-filter.js";

describe("applyPrivacyFilter", () => {
  it("anonymizes platform handles via the lookup callback", () => {
    const trajectory: FilterableTrajectory = {
      trajectoryId: "t-1",
      steps: [
        {
          llmCalls: [
            {
              userPrompt: "ping @alice please",
              response: "@alice replied",
            },
          ],
        },
      ],
    };
    const handlesToEntity: Record<string, string> = {
      "telegram:alice": "ent-001",
    };
    const result = applyPrivacyFilter([trajectory], {
      anonymizer: {
        resolveEntityId: (platform, handle) =>
          handlesToEntity[`${platform}:${handle}`] ?? null,
      },
    });
    expect(result.anonymizationCount).toBeGreaterThan(0);
    const text = result.trajectories[0]?.steps?.[0]?.llmCalls?.[0];
    expect(text?.userPrompt).toContain("<entity:ent-001>");
    expect(text?.response).toContain("<entity:ent-001>");
    expect(text?.userPrompt).not.toContain("@alice");
  });

  it("drops trajectories whose entities are marked private", () => {
    const trajectory: FilterableTrajectory = {
      trajectoryId: "t-private",
      steps: [
        {
          llmCalls: [{ userPrompt: "talk to @bob" }],
        },
      ],
    };
    const result = applyPrivacyFilter([trajectory], {
      anonymizer: {
        resolveEntityId: (_p, h) => (h === "bob" ? "ent-bob" : null),
        getPrivacyLevel: (entityId) =>
          entityId === "ent-bob" ? "private" : "public",
      },
    });
    expect(result.trajectories.length).toBe(0);
    expect(result.dropped.length).toBe(1);
    expect(result.dropped[0]?.reason).toBe("entity-private");
  });

  it("redacts API key shapes", () => {
    const trajectory: FilterableTrajectory = {
      trajectoryId: "t-creds",
      steps: [
        {
          llmCalls: [
            {
              systemPrompt: "Use Authorization: Bearer abcdefghijklmnopqrstuv",
              userPrompt: "key sk-abcdefghijklmnopqrstuvxyz0123456789",
              response: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
            },
          ],
        },
      ],
    };
    const result = applyPrivacyFilter([trajectory]);
    const call = result.trajectories[0]?.steps?.[0]?.llmCalls?.[0];
    expect(call?.systemPrompt).toContain("<REDACTED:bearer>");
    expect(call?.userPrompt).toContain("<REDACTED:openai-key>");
    expect(call?.response).toContain("<REDACTED:github-token>");
    expect(result.redactionCount).toBeGreaterThanOrEqual(3);
  });

  let prevSecret: string | undefined;
  beforeEach(() => {
    prevSecret = process.env.ELIZA_TEST_API_KEY;
    process.env.ELIZA_TEST_API_KEY = "supersecret-value-1234567890";
  });
  afterEach(() => {
    if (prevSecret === undefined) delete process.env.ELIZA_TEST_API_KEY;
    else process.env.ELIZA_TEST_API_KEY = prevSecret;
  });

  it("redacts environment-variable secret values when they appear inline", () => {
    const trajectory: FilterableTrajectory = {
      trajectoryId: "t-env",
      steps: [
        {
          llmCalls: [
            {
              userPrompt: "I leaked supersecret-value-1234567890 by accident",
            },
          ],
        },
      ],
    };
    const result = applyPrivacyFilter([trajectory], {
      envKeySnapshot: ["ELIZA_TEST_API_KEY"],
    });
    const call = result.trajectories[0]?.steps?.[0]?.llmCalls?.[0];
    expect(call?.userPrompt).toContain("<REDACTED:env-secret>");
    expect(call?.userPrompt).not.toContain("supersecret-value-1234567890");
  });

  it("preserves every page-scoped sortable metadata dimension verbatim", () => {
    // Pinning contract: the privacy filter operates on LLM call text only.
    // It MUST NOT silently strip any of the dimensions we stamp at send time
    // (webConversation.scope, taskId, surface, surfaceVersion, pageId,
    // sourceConversationId) — those are the only handles we have for sorting,
    // filtering, and per-scope MIPRO/GEPA optimization later. If a future
    // filter change starts touching metadata, this test breaks loudly.
    const trajectory: FilterableTrajectory = {
      trajectoryId: "t-page-scope",
      metadata: {
        webConversation: {
          conversationId: "conv-7",
          scope: "page-browser",
          pageId: "tab-99",
          sourceConversationId: "main-1",
        },
        taskId: "page-browser",
        surface: "page-scoped",
        surfaceVersion: 1,
        pageId: "tab-99",
        sourceConversationId: "main-1",
      },
      steps: [
        {
          llmCalls: [
            {
              userPrompt: "open hacker news with my key sk-abc1234567890XYZ",
              response: "Opening tab.",
            },
          ],
        },
      ],
    };
    const result = applyPrivacyFilter([trajectory]);
    expect(result.trajectories.length).toBe(1);
    const out = result.trajectories[0];
    expect(out?.metadata).toEqual(trajectory.metadata);
    // Sanity: the filter did still run on LLM text.
    expect(out?.steps?.[0]?.llmCalls?.[0]?.userPrompt).toContain(
      "<REDACTED:openai-key>",
    );
  });

  it("preserves automation-scope metadata too (parity with page-scopes)", () => {
    const trajectory: FilterableTrajectory = {
      trajectoryId: "t-auto-scope",
      metadata: {
        webConversation: {
          conversationId: "auto-1",
          scope: "automation-workflow",
          workflowId: "wf-1",
        },
      },
      steps: [{ llmCalls: [{ userPrompt: "run workflow" }] }],
    };
    const result = applyPrivacyFilter([trajectory]);
    expect(result.trajectories[0]?.metadata).toEqual(trajectory.metadata);
  });

  it("redacts geo coordinates in every supported shape", () => {
    const trajectory: FilterableTrajectory = {
      trajectoryId: "t-geo",
      steps: [
        {
          llmCalls: [
            {
              systemPrompt:
                'travel-time origin {"coords":{"latitude":37.7749,"longitude":-122.4194,"accuracy":50}} ready',
              userPrompt:
                "I am at 37.7749, -122.4194 and current location: 40.7128, -74.0060 — also lat: 51.5074, lng: -0.1278",
              response:
                '{"latitude":48.8566,"longitude":2.3522} arrived in Paris',
            },
          ],
        },
      ],
    };
    const result = applyPrivacyFilter([trajectory]);
    const call = result.trajectories[0]?.steps?.[0]?.llmCalls?.[0];

    expect(call?.systemPrompt).toContain("[REDACTED_GEO]");
    expect(call?.systemPrompt).not.toContain("37.7749");
    expect(call?.systemPrompt).not.toContain("-122.4194");
    expect(call?.systemPrompt).not.toContain("latitude");

    expect(call?.userPrompt).toContain("[REDACTED_GEO]");
    expect(call?.userPrompt).not.toContain("37.7749");
    expect(call?.userPrompt).not.toContain("40.7128");
    expect(call?.userPrompt).not.toContain("51.5074");

    expect(call?.response).toContain("[REDACTED_GEO]");
    expect(call?.response).not.toContain("48.8566");
    expect(call?.response).not.toContain("2.3522");
    expect(call?.response).toContain("arrived in Paris");

    // Each distinct geo span gets one redaction increment.
    expect(result.redactionCount).toBeGreaterThanOrEqual(5);
  });

  it("does not redact ordinary integer pairs that are not coordinates", () => {
    const trajectory: FilterableTrajectory = {
      trajectoryId: "t-geo-falseneg",
      steps: [
        {
          llmCalls: [
            {
              userPrompt:
                "transferred 100, 200 records — process IDs 1234, 5678 and step 12, 34",
            },
          ],
        },
      ],
    };
    const result = applyPrivacyFilter([trajectory]);
    const call = result.trajectories[0]?.steps?.[0]?.llmCalls?.[0];
    expect(call?.userPrompt).not.toContain("[REDACTED_GEO]");
    expect(call?.userPrompt).toContain("100, 200");
    expect(call?.userPrompt).toContain("1234, 5678");
  });
});

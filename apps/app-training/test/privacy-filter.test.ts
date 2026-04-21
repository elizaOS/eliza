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
    prevSecret = process.env.MILADY_TEST_API_KEY;
    process.env.MILADY_TEST_API_KEY = "supersecret-value-1234567890";
  });
  afterEach(() => {
    if (prevSecret === undefined) delete process.env.MILADY_TEST_API_KEY;
    else process.env.MILADY_TEST_API_KEY = prevSecret;
  });

  it("redacts environment-variable secret values when they appear inline", () => {
    const trajectory: FilterableTrajectory = {
      trajectoryId: "t-env",
      steps: [
        {
          llmCalls: [
            {
              userPrompt:
                "I leaked supersecret-value-1234567890 by accident",
            },
          ],
        },
      ],
    };
    const result = applyPrivacyFilter([trajectory], {
      envKeySnapshot: ["MILADY_TEST_API_KEY"],
    });
    const call = result.trajectories[0]?.steps?.[0]?.llmCalls?.[0];
    expect(call?.userPrompt).toContain("<REDACTED:env-secret>");
    expect(call?.userPrompt).not.toContain("supersecret-value-1234567890");
  });
});

import { describe, expect, it } from "vitest";
import {
  applyPrivacyFilter,
  createHashAnonymizer,
  type FilterableTrajectory,
} from "../src/core/privacy-filter.js";

function makeTrajectory(
  overrides: Partial<FilterableTrajectory> = {},
): FilterableTrajectory {
  return {
    trajectoryId: "t1",
    steps: [
      {
        llmCalls: [{ systemPrompt: "", userPrompt: "", response: "" }],
        providerAccesses: [],
      },
    ],
    ...overrides,
  };
}

function llmText(t: FilterableTrajectory): {
  systemPrompt?: string;
  userPrompt?: string;
  response?: string;
} {
  return t.steps?.[0]?.llmCalls?.[0] ?? {};
}

describe("privacy filter — credential redaction", () => {
  it("redacts API-key shapes and Bearer tokens", () => {
    const t = makeTrajectory();
    if (t.steps?.[0]?.llmCalls?.[0]) {
      t.steps[0].llmCalls[0].userPrompt =
        "use sk-ant-abcdef0123456789abcdef and Authorization: Bearer abcdefghijklmnop1234";
    }
    const { trajectories, redactionCount } = applyPrivacyFilter([t], {
      envKeySnapshot: [],
    });
    const text = llmText(trajectories[0]).userPrompt ?? "";
    expect(text).not.toContain("sk-ant-");
    expect(text).toContain("<REDACTED:anthropic-key>");
    expect(text).toContain("<REDACTED:bearer>");
    expect(redactionCount).toBeGreaterThanOrEqual(2);
  });

  it("redacts env-var secret values present in process.env", () => {
    process.env.__TEST_PRIVACY_API_KEY = "super-secret-token-value-123";
    try {
      const t = makeTrajectory();
      if (t.steps?.[0]?.llmCalls?.[0]) {
        t.steps[0].llmCalls[0].response =
          "the key is super-secret-token-value-123 ok";
      }
      const { trajectories } = applyPrivacyFilter([t], {
        envKeySnapshot: ["__TEST_PRIVACY_API_KEY"],
      });
      const text = llmText(trajectories[0]).response ?? "";
      expect(text).not.toContain("super-secret-token-value-123");
      expect(text).toContain("<REDACTED:env-secret>");
    } finally {
      delete process.env.__TEST_PRIVACY_API_KEY;
    }
  });
});

describe("privacy filter — geo redaction", () => {
  it("redacts labeled and bare decimal coordinate pairs", () => {
    const t = makeTrajectory();
    if (t.steps?.[0]?.llmCalls?.[0]) {
      t.steps[0].llmCalls[0].userPrompt =
        'I am at lat: 37.7749, lng: -122.4194 near {"latitude":40.71,"longitude":-74.0}';
    }
    const { trajectories } = applyPrivacyFilter([t], { envKeySnapshot: [] });
    const text = llmText(trajectories[0]).userPrompt ?? "";
    expect(text).not.toMatch(/37\.7749/);
    expect(text).not.toMatch(/-74\.0/);
    expect(text).toContain("[REDACTED_GEO]");
  });

  it("does not redact integer pairs (IDs / timestamps)", () => {
    const t = makeTrajectory();
    if (t.steps?.[0]?.llmCalls?.[0]) {
      t.steps[0].llmCalls[0].userPrompt = "ids 1024, 2048 and 3,5";
    }
    const { trajectories, redactionCount } = applyPrivacyFilter([t], {
      envKeySnapshot: [],
    });
    expect(llmText(trajectories[0]).userPrompt).toBe("ids 1024, 2048 and 3,5");
    expect(redactionCount).toBe(0);
  });
});

describe("privacy filter — PII redaction", () => {
  it("redacts email addresses", () => {
    const t = makeTrajectory();
    if (t.steps?.[0]?.llmCalls?.[0]) {
      t.steps[0].llmCalls[0].userPrompt =
        "email me at jane.doe+test@example.co.uk please";
    }
    const { trajectories } = applyPrivacyFilter([t], { envKeySnapshot: [] });
    const text = llmText(trajectories[0]).userPrompt ?? "";
    expect(text).not.toContain("@example.co.uk");
    expect(text).toContain("[REDACTED_EMAIL]");
  });

  it("redacts US and international phone numbers", () => {
    const t = makeTrajectory();
    if (t.steps?.[0]?.llmCalls?.[0]) {
      t.steps[0].llmCalls[0].response =
        "call (415) 555-0123 or +44 20 7946 0958 or 212-867-5309";
    }
    const { trajectories } = applyPrivacyFilter([t], { envKeySnapshot: [] });
    const text = llmText(trajectories[0]).response ?? "";
    expect(text).not.toMatch(/555-0123/);
    expect(text).not.toMatch(/7946 0958/);
    expect(text).not.toMatch(/867-5309/);
    expect(text).toContain("[REDACTED_PHONE]");
  });

  it("redacts street addresses, PO boxes and city/state/ZIP", () => {
    const t = makeTrajectory();
    if (t.steps?.[0]?.llmCalls?.[0]) {
      t.steps[0].llmCalls[0].userPrompt =
        "ship to 1600 Amphitheatre Parkway, Suite 200, Mountain View, CA 94043 or PO Box 4242";
    }
    const { trajectories } = applyPrivacyFilter([t], { envKeySnapshot: [] });
    const text = llmText(trajectories[0]).userPrompt ?? "";
    expect(text).not.toContain("Amphitheatre Parkway");
    expect(text).not.toContain("94043");
    expect(text).not.toMatch(/PO Box 4242/i);
    expect(text).toContain("[REDACTED_ADDRESS]");
  });
});

describe("privacy filter — deep walk of providerAccesses and metadata", () => {
  it("redacts string values nested in providerAccesses[].data", () => {
    const t: FilterableTrajectory = {
      trajectoryId: "t-pa",
      steps: [
        {
          llmCalls: [],
          providerAccesses: [
            {
              data: {
                contact: { email: "secret@person.com", note: "lat: 1.23, lng: 4.56" },
                list: ["call 415-555-9999"],
              },
            },
          ],
        },
      ],
    };
    const { trajectories } = applyPrivacyFilter([t], { envKeySnapshot: [] });
    const data = trajectories[0].steps?.[0]?.providerAccesses?.[0]?.data as {
      contact: { email: string; note: string };
      list: string[];
    };
    expect(data.contact.email).toBe("[REDACTED_EMAIL]");
    expect(data.contact.note).toContain("[REDACTED_GEO]");
    expect(data.list[0]).toContain("[REDACTED_PHONE]");
  });

  it("redacts string values nested in metadata", () => {
    const t = makeTrajectory({
      metadata: {
        userEmail: "user@host.io",
        nested: { phone: "(212) 555-7777" },
      },
    });
    const { trajectories } = applyPrivacyFilter([t], { envKeySnapshot: [] });
    const meta = trajectories[0].metadata as {
      userEmail: string;
      nested: { phone: string };
    };
    expect(meta.userEmail).toBe("[REDACTED_EMAIL]");
    expect(meta.nested.phone).toContain("[REDACTED_PHONE]");
  });
});

describe("privacy filter — handle anonymization", () => {
  it("does not touch handles when no anonymizer is supplied", () => {
    const t = makeTrajectory();
    if (t.steps?.[0]?.llmCalls?.[0]) {
      t.steps[0].llmCalls[0].userPrompt = "ping @alice and @bob";
    }
    const { trajectories, anonymizationCount } = applyPrivacyFilter([t], {
      envKeySnapshot: [],
    });
    expect(llmText(trajectories[0]).userPrompt).toBe("ping @alice and @bob");
    expect(anonymizationCount).toBe(0);
  });

  it("replaces handles with stable <entity:hash> ids via createHashAnonymizer", () => {
    const make = () => {
      const t = makeTrajectory();
      if (t.steps?.[0]?.llmCalls?.[0]) {
        t.steps[0].llmCalls[0].userPrompt = "ping @alice and @alice again";
      }
      return t;
    };
    const anonymizer = createHashAnonymizer("test-salt");
    const first = applyPrivacyFilter([make()], {
      envKeySnapshot: [],
      anonymizer,
    });
    const second = applyPrivacyFilter([make()], {
      envKeySnapshot: [],
      anonymizer,
    });
    const text = llmText(first.trajectories[0]).userPrompt ?? "";
    expect(text).not.toContain("@alice");
    expect(text).toMatch(/<entity:[0-9a-f]{16}>/);
    expect(first.anonymizationCount).toBe(2);
    // Same handle → same opaque id, stable across calls.
    const id1 = text.match(/<entity:([0-9a-f]{16})>/)?.[1];
    const id2 =
      (llmText(second.trajectories[0]).userPrompt ?? "").match(
        /<entity:([0-9a-f]{16})>/,
      )?.[1] ?? "";
    expect(id1).toBe(id2);
  });

  it("drops trajectories whose participating entity is private", () => {
    const t = makeTrajectory();
    if (t.steps?.[0]?.llmCalls?.[0]) {
      t.steps[0].llmCalls[0].userPrompt = "secret chat with @alice";
    }
    const anonymizer = {
      resolveEntityId: () => "ent-private",
      getPrivacyLevel: () => "private" as const,
    };
    const { trajectories, dropped } = applyPrivacyFilter([t], {
      envKeySnapshot: [],
      anonymizer,
    });
    expect(trajectories).toHaveLength(0);
    expect(dropped[0]?.reason).toBe("entity-private");
  });
});

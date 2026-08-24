/** Covers fail-closed parsing of /api/accounts inventory responses before UI state consumes them. */
import { ElizaError } from "@elizaos/core";
import {
  CODING_AGENT_BACKENDS,
  codingAgentSpawnCapabilityForProvider,
  codingProviderCredentialPathForProvider,
  codingProviderDescriptorForProvider,
  type LinkedAccountProviderId,
} from "@elizaos/shared";
import { describe, expect, it } from "vitest";
import {
  ACCOUNTS_RESPONSE_INVALID_CODE,
  parseAccountsListResponse,
} from "./client-agent-accounts-validator";

interface CapturedInvalid {
  code: string;
  path: string;
  expected: string;
  message: string;
}

function capture(value: unknown): CapturedInvalid {
  try {
    parseAccountsListResponse(value);
  } catch (error) {
    const elizaError = error as ElizaError & {
      context?: { path?: string; expected?: string };
    };
    return {
      code: elizaError.code as string,
      path: elizaError.context?.path as string,
      expected: elizaError.context?.expected as string,
      message: elizaError.message,
    };
  }
  throw new Error(
    "expected parseAccountsListResponse to reject this payload, but it accepted it",
  );
}

function canonicalRuntimeEligibility(providerId: LinkedAccountProviderId): {
  chat: { available: boolean; credentialPath: string };
  codingAgent: {
    backend?: string;
    unavailableReason?: string;
    available: boolean;
    credentialPath: string;
  };
} {
  const descriptor = codingProviderDescriptorForProvider(providerId);
  const credentialPath = codingProviderCredentialPathForProvider(providerId);
  const spawn = codingAgentSpawnCapabilityForProvider(providerId);
  if (!descriptor || !credentialPath) {
    throw new Error(
      `fixture provider ${providerId} has no canonical runtime contract`,
    );
  }
  const chatCredentialPath = descriptor.inferenceSupport
    ? credentialPath
    : "none";
  return {
    chat: {
      available: descriptor.inferenceSupport,
      credentialPath: chatCredentialPath,
    },
    codingAgent: {
      ...(spawn.available
        ? { backend: spawn.backend }
        : { unavailableReason: spawn.unavailableReason }),
      available: spawn.available,
      credentialPath: spawn.available ? credentialPath : "none",
    },
  };
}

function accountFixture(
  providerId: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: `${providerId}-primary`,
    providerId,
    label: "Primary",
    source: "api-key",
    enabled: true,
    priority: 0,
    createdAt: 1_700_000_000_000,
    health: "ok",
    hasCredential: true,
    ...overrides,
  };
}

function providerFixture(
  providerId: LinkedAccountProviderId,
  overrides: Record<string, unknown> = {},
) {
  return {
    providerId,
    strategy: "priority",
    runtimeEligibility: canonicalRuntimeEligibility(providerId),
    accounts: [accountFixture(providerId)],
    ...overrides,
  };
}

function responseFixture(providers: unknown[]) {
  return { providers };
}

describe("parseAccountsListResponse", () => {
  it("accepts a canonical multi-provider inventory and preserves feature-detected metadata", () => {
    const body = responseFixture([
      providerFixture("openai-api", {
        accounts: [
          accountFixture("openai-api", {
            lastUsedAt: 1_700_001_000_000,
            lastPrimedAt: 1_700_002_000_000,
            subscriptionEndsAt: 1_800_000_000_000,
            organizationId: "org_1",
            userId: "user_1",
            email: "owner@example.com",
            healthDetail: {
              until: 1_700_003_000_000,
              lastError: "transient 429",
              lastChecked: 1_700_000_500_000,
            },
            usage: {
              refreshedAt: 1_700_000_000_000,
              sessionPct: 12.5,
              weeklyPct: 40,
              resetsAt: 1_700_008_000_000,
              weeklyModelBuckets: {
                "gpt-5.2": { pct: 30, resetsAt: 1_700_010_000_000 },
                "gpt-5.2-mini": { pct: 10 },
              },
            },
          }),
        ],
      }),
      providerFixture("openai-codex", {
        accounts: [
          accountFixture("openai-codex", {
            id: "codex-primary",
            source: "oauth",
          }),
        ],
      }),
    ]);

    const parsed = parseAccountsListResponse(body);
    expect(parsed).toEqual(body);
  });

  it("returns the identical object reference so UI state can consume it directly", () => {
    const body = responseFixture([providerFixture("openai-api")]);
    expect(parseAccountsListResponse(body)).toBe(body);
  });

  it("accepts an empty provider roster and providers with no linked accounts", () => {
    expect(() => parseAccountsListResponse(responseFixture([]))).not.toThrow();
    expect(() =>
      parseAccountsListResponse(
        responseFixture([providerFixture("openai-api", { accounts: [] })]),
      ),
    ).not.toThrow();
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["a string", "providers"],
    ["a number", 42],
  ])("rejects %s as the top-level response", (_label, value) => {
    expect(capture(value).path).toBe("response");
  });

  it("rejects a providers field that is not an array", () => {
    expect(capture({ providers: {} }).path).toBe("response.providers");
  });

  it("rejects an unsupported linked-account provider id", () => {
    const body = responseFixture([
      providerFixture("openai-api", { providerId: "skynet-api" }),
    ]);
    expect(capture(body).path).toBe("response.providers[0].providerId");
  });

  it("rejects duplicate provider entries", () => {
    const body = responseFixture([
      providerFixture("openai-api"),
      providerFixture("openai-api"),
    ]);
    const invalid = capture(body);
    expect(invalid.path).toBe("response.providers[1].providerId");
    expect(invalid.expected).toBe("a unique provider");
  });

  it("rejects an unsupported account strategy", () => {
    const body = responseFixture([
      providerFixture("openai-api", { strategy: "cheapest" }),
    ]);
    expect(capture(body).path).toBe("response.providers[0].strategy");
  });

  it("rejects an accounts field that is not an array", () => {
    const body = responseFixture([
      providerFixture("openai-api", { accounts: "primary" }),
    ]);
    expect(capture(body).path).toBe("response.providers[0].accounts");
  });

  it("rejects duplicate account ids within one provider but accepts the same id under different providers", () => {
    const duplicated = responseFixture([
      providerFixture("openai-api", {
        accounts: [
          accountFixture("openai-api", { id: "shared-id" }),
          accountFixture("openai-api", { id: "shared-id" }),
        ],
      }),
    ]);
    const invalid = capture(duplicated);
    expect(invalid.path).toBe("response.providers[0].accounts[1].id");
    expect(invalid.expected).toBe("a unique account id within its provider");

    const acrossProviders = responseFixture([
      providerFixture("openai-api", {
        accounts: [accountFixture("openai-api", { id: "shared-id" })],
      }),
      providerFixture("openai-codex", {
        accounts: [accountFixture("openai-codex", { id: "shared-id" })],
      }),
    ]);
    expect(() => parseAccountsListResponse(acrossProviders)).not.toThrow();
  });

  it.each([
    ["an empty id", { id: "" }, "response.providers[0].accounts[0].id"],
    [
      "a whitespace-only label",
      { label: "   " },
      "response.providers[0].accounts[0].label",
    ],
    [
      "a mismatched parent provider",
      { providerId: "deepseek-api" },
      "response.providers[0].accounts[0].providerId",
    ],
    [
      "an unsupported account source",
      { source: "token" },
      "response.providers[0].accounts[0].source",
    ],
    [
      "a non-boolean enabled flag",
      { enabled: "yes" },
      "response.providers[0].accounts[0].enabled",
    ],
    [
      "a NaN priority",
      { priority: Number.NaN },
      "response.providers[0].accounts[0].priority",
    ],
    [
      "an infinite priority",
      { priority: Number.POSITIVE_INFINITY },
      "response.providers[0].accounts[0].priority",
    ],
    [
      "a numeric-string createdAt",
      { createdAt: "recently" },
      "response.providers[0].accounts[0].createdAt",
    ],
    [
      "an unknown health state",
      { health: "degraded" },
      "response.providers[0].accounts[0].health",
    ],
    [
      "a non-boolean hasCredential",
      { hasCredential: 1 },
      "response.providers[0].accounts[0].hasCredential",
    ],
    [
      "an unknown prioritySource",
      { prioritySource: "auto" },
      "response.providers[0].accounts[0].prioritySource",
    ],
  ])("rejects an account carrying %s", (_label, overrides, path) => {
    const body = responseFixture([
      providerFixture("openai-api", {
        accounts: [accountFixture("openai-api", overrides)],
      }),
    ]);
    expect(capture(body).path).toBe(path);
  });

  it("accepts both explicit and generated prioritySource values", () => {
    const body = responseFixture([
      providerFixture("openai-api", {
        accounts: [
          accountFixture("openai-api", { prioritySource: "explicit" }),
          accountFixture("openai-api", {
            id: "generated",
            prioritySource: "generated",
          }),
        ],
      }),
    ]);
    expect(() => parseAccountsListResponse(body)).not.toThrow();
  });

  it.each([
    [
      "a non-finite lastUsedAt",
      { lastUsedAt: "soon" },
      "response.providers[0].accounts[0].lastUsedAt",
    ],
    [
      "a non-string email",
      { email: 42 },
      "response.providers[0].accounts[0].email",
    ],
  ])("rejects an optional field holding %s", (_label, overrides, path) => {
    const body = responseFixture([
      providerFixture("openai-api", {
        accounts: [accountFixture("openai-api", overrides)],
      }),
    ]);
    expect(capture(body).path).toBe(path);
  });

  it.each([
    [
      "a scalar healthDetail",
      "ok",
      "response.providers[0].accounts[0].healthDetail",
    ],
    [
      "a non-string healthDetail.lastError",
      { lastError: 7 },
      "response.providers[0].accounts[0].healthDetail.lastError",
    ],
  ])("rejects %s", (_label, healthDetail, path) => {
    const body = responseFixture([
      providerFixture("openai-api", {
        accounts: [accountFixture("openai-api", { healthDetail })],
      }),
    ]);
    expect(capture(body).path).toBe(path);
  });

  it("rejects usage without a finite refreshedAt timestamp", () => {
    const body = responseFixture([
      providerFixture("openai-api", {
        accounts: [accountFixture("openai-api", { usage: {} })],
      }),
    ]);
    expect(capture(body).path).toBe(
      "response.providers[0].accounts[0].usage.refreshedAt",
    );
  });

  it.each([
    ["sessionPct", "sessionPct", 101, ".sessionPct"],
    ["weeklyPct", "weeklyPct", -1, ".weeklyPct"],
  ])(
    "rejects out-of-range usage percentage %s",
    (_label, key, value, suffix) => {
      const body = responseFixture([
        providerFixture("openai-api", {
          accounts: [
            accountFixture("openai-api", {
              usage: { refreshedAt: 1, [key]: value },
            }),
          ],
        }),
      ]);
      const invalid = capture(body);
      expect(invalid.path).toBe(
        `response.providers[0].accounts[0].usage${suffix}`,
      );
      expect(invalid.expected).toBe("a percentage from 0 to 100");
    },
  );

  it("rejects non-object weekly model buckets", () => {
    const body = responseFixture([
      providerFixture("openai-api", {
        accounts: [
          accountFixture("openai-api", {
            usage: { refreshedAt: 1, weeklyModelBuckets: "high" },
          }),
        ],
      }),
    ]);
    expect(capture(body).path).toBe(
      "response.providers[0].accounts[0].usage.weeklyModelBuckets",
    );
  });

  it("rejects model buckets whose key is blank or whose percentage is out of range", () => {
    const blankKey = responseFixture([
      providerFixture("openai-api", {
        accounts: [
          accountFixture("openai-api", {
            usage: {
              refreshedAt: 1,
              weeklyModelBuckets: { "   ": { pct: 10 } },
            },
          }),
        ],
      }),
    ]);
    const blankInvalid = capture(blankKey);
    expect(blankInvalid.expected).toBe("a model usage object");

    const outOfRange = responseFixture([
      providerFixture("openai-api", {
        accounts: [
          accountFixture("openai-api", {
            usage: {
              refreshedAt: 1,
              weeklyModelBuckets: { "gpt-5.2": { pct: 140 } },
            },
          }),
        ],
      }),
    ]);
    const rangeInvalid = capture(outOfRange);
    expect(rangeInvalid.path).toBe(
      "response.providers[0].accounts[0].usage.weeklyModelBuckets.gpt-5.2.pct",
    );
    expect(rangeInvalid.expected).toBe("a percentage from 0 to 100");
  });

  it("rejects runtime eligibility whose chat capability is not an object", () => {
    const eligibility = canonicalRuntimeEligibility("openai-api");
    const body = responseFixture([
      providerFixture("openai-api", {
        runtimeEligibility: { ...eligibility, chat: 7 },
      }),
    ]);
    expect(capture(body).path).toBe(
      "response.providers[0].runtimeEligibility.chat",
    );
  });

  it("rejects a chat availability that contradicts the canonical descriptor", () => {
    const eligibility = canonicalRuntimeEligibility("openai-api");
    const body = responseFixture([
      providerFixture("openai-api", {
        runtimeEligibility: {
          ...eligibility,
          chat: { ...eligibility.chat, available: !eligibility.chat.available },
        },
      }),
    ]);
    const invalid = capture(body);
    expect(invalid.path).toBe(
      "response.providers[0].runtimeEligibility.chat.available",
    );
    expect(invalid.expected).toContain('provider "openai-api"');
  });

  it("rejects a chat credential path that contradicts the canonical contract", () => {
    const eligibility = canonicalRuntimeEligibility("openai-api");
    const canonicalPath = eligibility.chat.credentialPath;
    const body = responseFixture([
      providerFixture("openai-api", {
        runtimeEligibility: {
          ...eligibility,
          chat: {
            ...eligibility.chat,
            credentialPath: canonicalPath === "none" ? "direct-api" : "none",
          },
        },
      }),
    ]);
    const invalid = capture(body);
    expect(invalid.path).toBe(
      "response.providers[0].runtimeEligibility.chat.credentialPath",
    );
    expect(invalid.expected).toBe(
      `the canonical credential path "${canonicalPath}"`,
    );
  });

  it("rejects a coding-agent availability that contradicts the canonical spawn capability", () => {
    const eligibility = canonicalRuntimeEligibility("openai-api");
    const body = responseFixture([
      providerFixture("openai-api", {
        runtimeEligibility: {
          ...eligibility,
          codingAgent: {
            ...eligibility.codingAgent,
            available: !eligibility.codingAgent.available,
          },
        },
      }),
    ]);
    expect(capture(body).path).toBe(
      "response.providers[0].runtimeEligibility.codingAgent.available",
    );
  });

  it("rejects a spawnable provider advertising a foreign backend", () => {
    const eligibility = canonicalRuntimeEligibility("openai-codex");
    expect(eligibility.codingAgent.available).toBe(true);
    const canonicalBackend = eligibility.codingAgent.backend;
    const foreignBackend = CODING_AGENT_BACKENDS.find(
      (backend) => backend !== canonicalBackend,
    );
    const body = responseFixture([
      providerFixture("openai-codex", {
        runtimeEligibility: {
          ...eligibility,
          codingAgent: { ...eligibility.codingAgent, backend: foreignBackend },
        },
      }),
    ]);
    const invalid = capture(body);
    expect(invalid.path).toBe(
      "response.providers[0].runtimeEligibility.codingAgent.backend",
    );
    expect(invalid.expected).toBe(
      `the canonical backend "${canonicalBackend}"`,
    );
  });

  it("rejects an unspawnable provider advertising any backend", () => {
    const eligibility = canonicalRuntimeEligibility("openai-api");
    expect(eligibility.codingAgent.available).toBe(false);
    const body = responseFixture([
      providerFixture("openai-api", {
        runtimeEligibility: {
          ...eligibility,
          codingAgent: { ...eligibility.codingAgent, backend: "codex" },
        },
      }),
    ]);
    const invalid = capture(body);
    expect(invalid.path).toBe(
      "response.providers[0].runtimeEligibility.codingAgent.backend",
    );
    expect(invalid.expected).toBe("no backend for an unavailable provider");
  });

  it("rejects a coding-agent credential path that contradicts the canonical contract", () => {
    const eligibility = canonicalRuntimeEligibility("openai-codex");
    const canonicalPath = eligibility.codingAgent.credentialPath;
    const body = responseFixture([
      providerFixture("openai-codex", {
        runtimeEligibility: {
          ...eligibility,
          codingAgent: {
            ...eligibility.codingAgent,
            credentialPath: canonicalPath === "none" ? "direct-api" : "none",
          },
        },
      }),
    ]);
    const invalid = capture(body);
    expect(invalid.path).toBe(
      "response.providers[0].runtimeEligibility.codingAgent.credentialPath",
    );
    expect(invalid.expected).toBe(
      `the canonical credential path "${canonicalPath}"`,
    );
  });

  it("throws an ElizaError carrying the stable invalid-response classification", () => {
    expect(ACCOUNTS_RESPONSE_INVALID_CODE).toBe("ACCOUNTS_RESPONSE_INVALID");
    let thrown: unknown;
    try {
      parseAccountsListResponse({ providers: null });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ElizaError);
    const elizaError = thrown as ElizaError;
    expect(elizaError.code).toBe(ACCOUNTS_RESPONSE_INVALID_CODE);
    expect(elizaError.message).toContain("Invalid /api/accounts response");
    expect(elizaError.message).toContain("response.providers");
  });
});

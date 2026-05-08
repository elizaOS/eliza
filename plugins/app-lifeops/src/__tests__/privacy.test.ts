import type {
  ConnectorAccount,
  IAgentRuntime,
  PrivacyLevel,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

const CONNECTOR_ACCOUNT_SERVICE_TYPE = "connector_account";

// Stub the runtime values pulled in from @elizaos/core so the test does not
// transitively load advanced-capabilities action specs (which require build
// artifacts that may not be present in this test environment). Type-only
// imports above are erased at runtime and do not trigger this load.
vi.mock("@elizaos/core", () => ({
  getConnectorAccountManager(runtime: IAgentRuntime) {
    return runtime.getService(CONNECTOR_ACCOUNT_SERVICE_TYPE);
  },
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  DEFAULT_PRIVACY_LEVEL: "owner_only" as PrivacyLevel,
  PRIVACY_LEVELS: [
    "owner_only",
    "team_visible",
    "semi_public",
    "public",
  ] as PrivacyLevel[],
  getAccountPrivacy(account: ConnectorAccount): PrivacyLevel {
    const raw = account.metadata?.privacy;
    const allowed: readonly PrivacyLevel[] = [
      "owner_only",
      "team_visible",
      "semi_public",
      "public",
    ];
    return typeof raw === "string" &&
      (allowed as readonly string[]).includes(raw)
      ? (raw as PrivacyLevel)
      : "owner_only";
  },
}));

const {
  canSurfaceAccountData,
  canSurfaceForAudience,
  filterAccountsForAudience,
} = await import("../lifeops/privacy.js");

type LifeOpsAudience =
  | "owner"
  | "team"
  | "agent_message_recipient"
  | "public";

const PRIVACY_LEVELS: PrivacyLevel[] = [
  "owner_only",
  "team_visible",
  "semi_public",
  "public",
];

const AUDIENCES: LifeOpsAudience[] = [
  "owner",
  "team",
  "agent_message_recipient",
  "public",
];

const EXPECTED: Record<PrivacyLevel, Record<LifeOpsAudience, boolean>> = {
  owner_only: {
    owner: true,
    team: false,
    agent_message_recipient: false,
    public: false,
  },
  team_visible: {
    owner: true,
    team: true,
    agent_message_recipient: false,
    public: false,
  },
  semi_public: {
    owner: true,
    team: true,
    agent_message_recipient: true,
    public: false,
  },
  public: {
    owner: true,
    team: true,
    agent_message_recipient: true,
    public: true,
  },
};

interface FakeManager {
  getAccount: (
    provider: string,
    accountId: string,
  ) => Promise<ConnectorAccount | null>;
}

function makeFakeManager(accounts: ConnectorAccount[]): FakeManager {
  return {
    async getAccount(provider, accountId) {
      return (
        accounts.find(
          (account) =>
            account.provider === provider && account.id === accountId,
        ) ?? null
      );
    },
  };
}

function makeAccount(
  overrides: Partial<ConnectorAccount> & { privacy?: PrivacyLevel } = {},
): ConnectorAccount {
  const now = Date.now();
  const { privacy, metadata, ...rest } = overrides;
  return {
    id: "acct_1",
    provider: "google",
    role: "OWNER",
    purpose: ["reading"],
    accessGate: "open",
    status: "connected",
    createdAt: now,
    updatedAt: now,
    metadata: privacy
      ? { ...(metadata ?? {}), privacy }
      : (metadata ?? undefined),
    ...rest,
  };
}

function makeRuntimeWithManager(accounts: ConnectorAccount[]): IAgentRuntime {
  const manager = makeFakeManager(accounts);
  return {
    agentId: "agent-1",
    getService: vi.fn((serviceType: string) =>
      serviceType === CONNECTOR_ACCOUNT_SERVICE_TYPE ? manager : null,
    ),
  } as unknown as IAgentRuntime;
}

describe("LifeOps privacy lattice", () => {
  it("matches expected boolean for every (privacy, audience) combination", () => {
    for (const privacy of PRIVACY_LEVELS) {
      for (const audience of AUDIENCES) {
        expect({
          privacy,
          audience,
          allowed: canSurfaceForAudience(privacy, audience),
        }).toEqual({
          privacy,
          audience,
          allowed: EXPECTED[privacy][audience],
        });
      }
    }
  });
});

describe("canSurfaceAccountData", () => {
  it("returns the privacy lattice answer when the account exists", async () => {
    const runtime = makeRuntimeWithManager([
      makeAccount({ id: "acct_owner", privacy: "owner_only" }),
      makeAccount({ id: "acct_team", privacy: "team_visible" }),
    ]);

    expect(
      await canSurfaceAccountData({
        runtime,
        provider: "google",
        accountId: "acct_owner",
        audience: "owner",
      }),
    ).toBe(true);
    expect(
      await canSurfaceAccountData({
        runtime,
        provider: "google",
        accountId: "acct_owner",
        audience: "team",
      }),
    ).toBe(false);
    expect(
      await canSurfaceAccountData({
        runtime,
        provider: "google",
        accountId: "acct_team",
        audience: "team",
      }),
    ).toBe(true);
    expect(
      await canSurfaceAccountData({
        runtime,
        provider: "google",
        accountId: "acct_team",
        audience: "agent_message_recipient",
      }),
    ).toBe(false);
  });

  it("defaults to owner_only when the privacy field is missing", async () => {
    const runtime = makeRuntimeWithManager([
      makeAccount({ id: "acct_no_privacy" }),
    ]);

    expect(
      await canSurfaceAccountData({
        runtime,
        provider: "google",
        accountId: "acct_no_privacy",
        audience: "owner",
      }),
    ).toBe(true);
    expect(
      await canSurfaceAccountData({
        runtime,
        provider: "google",
        accountId: "acct_no_privacy",
        audience: "team",
      }),
    ).toBe(false);
  });

  it("defaults to owner_only when the privacy value is unrecognized", async () => {
    const runtime = makeRuntimeWithManager([
      makeAccount({
        id: "acct_bad",
        metadata: { privacy: "garbage" } as Record<string, unknown>,
      }),
    ]);

    expect(
      await canSurfaceAccountData({
        runtime,
        provider: "google",
        accountId: "acct_bad",
        audience: "team",
      }),
    ).toBe(false);
  });

  it("returns false when the account does not exist (fail-safe)", async () => {
    const runtime = makeRuntimeWithManager([]);

    expect(
      await canSurfaceAccountData({
        runtime,
        provider: "google",
        accountId: "missing",
        audience: "team",
      }),
    ).toBe(false);
  });
});

describe("filterAccountsForAudience (provider-context end-to-end)", () => {
  it("surfaces team_visible accounts and hides owner_only ones for team audience", () => {
    const ownerOnly = makeAccount({
      id: "acct_owner",
      privacy: "owner_only",
    });
    const teamVisible = makeAccount({
      id: "acct_team",
      privacy: "team_visible",
    });

    const filtered = filterAccountsForAudience(
      [ownerOnly, teamVisible],
      "team",
      { provider: "google" },
    );

    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.id).toBe("acct_team");
  });

  it("surfaces every account for the owner audience regardless of privacy", () => {
    const accounts = PRIVACY_LEVELS.map((privacy, index) =>
      makeAccount({ id: `acct_${index}`, privacy }),
    );

    const filtered = filterAccountsForAudience(accounts, "owner", {
      provider: "google",
    });

    expect(filtered.map((a) => a.id)).toEqual(accounts.map((a) => a.id));
  });

  it("hides every non-public account for the public audience", () => {
    const accounts = PRIVACY_LEVELS.map((privacy, index) =>
      makeAccount({ id: `acct_${index}`, privacy }),
    );

    const filtered = filterAccountsForAudience(accounts, "public", {
      provider: "google",
    });

    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.metadata?.privacy).toBe("public");
  });
});

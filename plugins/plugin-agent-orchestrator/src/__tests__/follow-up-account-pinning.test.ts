/**
 * Proves cli-transport follow-up prompts stay billed to the account that is
 * actually authenticating the subprocess. The fake selector bridge reproduces
 * the real pool's post-affinity-expiry behavior (least-used prefers the
 * sibling of the just-used account), so an un-pinned re-resolve DRIFTS —
 * exactly the bug: the subprocess auths as account B while usage records and
 * health marks stay keyed to spawn-time account A. Deterministic; no live
 * model, real AcpService + real in-memory session store.
 */

import type {
  CodingAgentSelection,
  CodingAgentSelectorBridge,
  IAgentRuntime,
} from "@elizaos/core";
import { setCodingAgentSelectorBridge } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AcpService } from "../services/acp-service.js";
import type { CodingAccountMeta } from "../services/coding-account-selection.js";
import { InMemorySessionStore } from "../services/session-store.js";
import type { SessionInfo } from "../services/types.js";

const ACCOUNT_A: CodingAccountMeta = {
  providerId: "anthropic-subscription",
  accountId: "acct-a",
  label: "A",
  source: "oauth",
  strategy: "least-used",
};

function selection(accountId: string, token: string): CodingAgentSelection {
  return {
    providerId: "anthropic-subscription",
    accountId,
    label: accountId === "acct-a" ? "A" : "B",
    source: "oauth",
    strategy: "least-used",
    envPatch: { CLAUDE_CODE_OAUTH_TOKEN: token },
  };
}

/**
 * Bridge double with the REAL pool's failure mode baked in: with session
 * affinity expired, an unconstrained least-used select returns the SIBLING
 * (`acct-b`) because the affine account carries the freshest selection stamp.
 * `accountIds` restricts the pool exactly like AccountPool.filterEligible, and
 * `healthyIds` models rate-limit/needs-reauth eligibility.
 */
function makeBridge(opts: { healthyIds: string[] }) {
  const calls: Array<{
    accountIds?: string[];
    exclude?: string[];
    sessionKey?: string;
  }> = [];
  const bridge: CodingAgentSelectorBridge = {
    describe: () => ({}),
    async select(_agentType, selectOpts) {
      calls.push({
        accountIds: selectOpts?.accountIds,
        exclude: selectOpts?.exclude,
        sessionKey: selectOpts?.sessionKey,
      });
      const eligible = opts.healthyIds
        .filter((id) => !selectOpts?.exclude?.includes(id))
        .filter(
          (id) => !selectOpts?.accountIds || selectOpts.accountIds.includes(id),
        );
      if (eligible.length === 0) return null;
      // Post-affinity-expiry least-used: the sibling wins when unconstrained.
      const picked = eligible.includes("acct-b") ? "acct-b" : eligible[0];
      if (!picked) return null;
      return selection(picked, `token-${picked}`);
    },
    async markRateLimited() {},
    async markNeedsReauth() {},
    async recordUsage() {},
  };
  return { bridge, calls };
}

function makeRuntime(): IAgentRuntime {
  return {
    agentId: "00000000-0000-4000-8000-00000000acp1",
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    getSetting: () => undefined,
  } as never;
}

function makeSession(): SessionInfo {
  const now = new Date();
  return {
    id: "sess-pin-1",
    name: "sess-pin-1",
    agentType: "claude",
    workdir: "/tmp/pin-test",
    status: "ready",
    approvalPreset: "approve-all",
    createdAt: now,
    lastActivityAt: now,
    metadata: { account: { ...ACCOUNT_A } },
  };
}

type CredentialResolver = {
  accountCredentialsForSession(
    session: SessionInfo,
  ): Promise<Record<string, string> | undefined>;
};

describe("follow-up prompt account pinning (cli transport)", () => {
  let store: InMemorySessionStore;
  let service: AcpService;

  beforeEach(() => {
    store = new InMemorySessionStore();
    service = new AcpService(makeRuntime(), { store });
  });

  afterEach(() => {
    setCodingAgentSelectorBridge(null);
  });

  it("re-resolves the SPAWN-TIME account when both accounts are healthy (no drift)", async () => {
    const { bridge, calls } = makeBridge({ healthyIds: ["acct-a", "acct-b"] });
    setCodingAgentSelectorBridge(bridge);
    const session = makeSession();
    await store.create(session);

    const env = await (
      service as unknown as CredentialResolver
    ).accountCredentialsForSession(session);

    // The bug: an un-pinned re-select drifts to acct-b, so the subprocess
    // bills B while usage/health marks stay keyed to A.
    expect(env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("token-acct-a");
    expect(calls[0]?.accountIds).toEqual(["acct-a"]);
    // Still keyed to the spawn-time account everywhere.
    const stored = await store.get(session.id);
    const meta = stored?.metadata?.account as CodingAccountMeta;
    expect(meta.accountId).toBe("acct-a");
  });

  it("fails over and re-stamps session + emits account_switched when the pinned account is unhealthy", async () => {
    const { bridge, calls } = makeBridge({ healthyIds: ["acct-b"] });
    setCodingAgentSelectorBridge(bridge);
    const session = makeSession();
    await store.create(session);
    const events: Array<{ event: string; data: unknown }> = [];
    service.onSessionEvent((sessionId, event, data) => {
      if (sessionId === session.id) events.push({ event, data });
    });

    const env = await (
      service as unknown as CredentialResolver
    ).accountCredentialsForSession(session);

    expect(env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("token-acct-b");
    // First call pinned to A; the failover pick excluded the dud.
    expect(calls[0]?.accountIds).toEqual(["acct-a"]);
    expect(calls[1]?.exclude).toEqual(["acct-a"]);
    // Session metadata follows the credential actually injected — in memory
    // (next prompt's pin) and durably.
    expect((session.metadata?.account as CodingAccountMeta).accountId).toBe(
      "acct-b",
    );
    const stored = await store.get(session.id);
    expect((stored?.metadata?.account as CodingAccountMeta).accountId).toBe(
      "acct-b",
    );
    // The event bridge carries the re-key to the orchestrator task store.
    const switched = events.find((e) => e.event === "account_switched");
    expect(switched?.data).toMatchObject({
      providerId: "anthropic-subscription",
      accountId: "acct-b",
      label: "B",
    });
  });

  it("returns undefined without selecting when the session has no linked account", async () => {
    const { bridge, calls } = makeBridge({ healthyIds: ["acct-a", "acct-b"] });
    setCodingAgentSelectorBridge(bridge);
    const session: SessionInfo = { ...makeSession(), metadata: {} };
    await store.create(session);

    const env = await (
      service as unknown as CredentialResolver
    ).accountCredentialsForSession(session);

    expect(env).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("returns undefined when neither the pinned account nor a failover is available", async () => {
    const { bridge } = makeBridge({ healthyIds: [] });
    setCodingAgentSelectorBridge(bridge);
    const session = makeSession();
    await store.create(session);

    const env = await (
      service as unknown as CredentialResolver
    ).accountCredentialsForSession(session);

    expect(env).toBeUndefined();
    // No failover happened, so the session must stay keyed to A.
    expect((session.metadata?.account as CodingAccountMeta).accountId).toBe(
      "acct-a",
    );
  });
});

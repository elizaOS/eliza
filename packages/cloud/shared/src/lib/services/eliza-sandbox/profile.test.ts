/** Exercises sandbox profile contracts with explicit database simulation. Real durable authority is covered separately by the PGlite suites. */

import { describe, expect, mock, spyOn, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import type { AgentSandbox } from "../../../db/repositories/agent-sandboxes";
import { SandboxLifecycleAuthority } from "./lifecycle/authority.js";

/**
 * Covers sandbox lifecycle, state transfer, recovery, and upgrade invariants
 * using deterministic repository and provider fixtures.
 */

import { afterAll, afterEach, beforeAll } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { apiKeysService } from "../api-keys";
import {
  AGENT_CHARACTER_OWNERSHIP_KEY,
  AGENT_MANAGED_DISCORD_GATEWAY_KEY,
  AGENT_MANAGED_DISCORD_KEY,
  AGENT_MANAGED_GITHUB_KEY,
  AGENT_PERSONAL_CUTOVER_KEY,
  AGENT_UPGRADED_FROM_KEY,
} from "../eliza-agent-config";
import {
  installSandboxBillingSimulation,
  installSandboxDatabaseSimulation,
  sandboxTransactions,
  UpgradeTx,
} from "./test-support/database.js";
import { customSandbox } from "./test-support/fixtures.js";

const originalFetch = globalThis.fetch;
const originalWebSocketPair = Object.getOwnPropertyDescriptor(globalThis, "WebSocketPair");
function restoreWebSocketPair() {
  if (originalWebSocketPair)
    Object.defineProperty(globalThis, "WebSocketPair", originalWebSocketPair);
  else Reflect.deleteProperty(globalThis, "WebSocketPair");
}
afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreWebSocketPair();
});

let restoreDatabase: (() => void) | undefined;
let restoreReplacement: (() => void) | undefined;
let billing: ReturnType<typeof installSandboxBillingSimulation>;
beforeAll(async () => {
  restoreDatabase = installSandboxDatabaseSimulation();
  billing = installSandboxBillingSimulation();
});
afterAll(() => {
  billing.restore();
  restoreReplacement?.();
  restoreDatabase?.();
});
describe("ElizaSandboxService updateAgentProfile / updateAgentEnvironment", () => {
  type MutableProfileService = {
    updateAgentProfile(
      agentId: string,
      orgId: string,
      input: { agentName?: string; agentConfig?: Record<string, unknown> },
    ): Promise<AgentSandbox | undefined>;
    updateAgentEnvironment(
      agentId: string,
      orgId: string,
      environmentVars: Record<string, string>,
    ): Promise<AgentSandbox | undefined>;
    prepareManagedLaunchEnvironment(params: {
      agentId: string;
      organizationId: string;
      userId: string;
    }): Promise<
      | {
          sandbox: AgentSandbox;
          environment: { agentApiKey: string };
        }
      | undefined
    >;
    lockLifecycle(tx: unknown, agentId: string, orgId: string): Promise<void>;
    getAgentForLifecycleMutation(
      tx: unknown,
      agentId: string,
      orgId: string,
    ): Promise<AgentSandbox | undefined>;
  };

  function installLifecycleUpdateTransaction(
    existing: AgentSandbox | undefined,
    options: { persist?: boolean; authority?: Record<string, unknown> } = {},
  ) {
    let whereClause: SQL | undefined;
    const updateSet = mock((values: Record<string, unknown>) => ({
      where: mock((clause: SQL) => {
        whereClause = clause;
        return {
          returning: mock(async () =>
            existing && options.persist !== false
              ? [{ ...existing, ...values } as AgentSandbox]
              : [],
          ),
        };
      }),
    }));
    const update = mock(() => ({ set: updateSet }));
    const handle = {
      execute: async () => ({ rows: [] }),
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => (options.authority ? [options.authority] : []),
          }),
        }),
      }),
      update,
    } as unknown as UpgradeTx;
    sandboxTransactions.implementation = async (fn) => fn(handle);
    return {
      update,
      updateSet,
      handle,
      getWhereClause: () => whereClause,
    };
  }

  async function makeMutableService(existing: AgentSandbox | undefined) {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const svc = new ElizaSandboxService() as unknown as MutableProfileService;
    const lock = spyOn(SandboxLifecycleAuthority.prototype, "lockLifecycle").mockResolvedValue(
      undefined,
    );
    const read = spyOn(
      SandboxLifecycleAuthority.prototype,
      "getAgentForLifecycleMutation",
    ).mockResolvedValue(existing);
    return { svc, lock, read };
  }

  test("updateAgentProfile merges a partial config edit into the existing config and applies the name", async () => {
    const existing = {
      ...customSandbox(),
      agent_config: { system: "old system", temperature: 0.7 },
    };
    const tx = installLifecycleUpdateTransaction(existing);
    const { svc, lock, read } = await makeMutableService(existing);
    try {
      const result = await svc.updateAgentProfile(existing.id, existing.organization_id, {
        agentName: "Renamed",
        agentConfig: { system: "new system" },
      });
      // A partial config edit must never drop sibling keys (the merge is the
      // whole reason this method exists — a raw update would clobber them).
      expect(tx.updateSet).toHaveBeenCalledWith({
        agent_name: "Renamed",
        agent_config: { system: "new system", temperature: 0.7 },
        updated_at: expect.any(Date),
      });
      expect(result?.agent_name).toBe("Renamed");
      const whereClause = tx.getWhereClause();
      if (!whereClause) throw new Error("profile update did not build a delete fence");
      const query = new PgDialect().sqlToQuery(whereClause);
      expect(query.sql.toLowerCase()).toContain("deletion_attempt_id");
      expect(query.sql.toLowerCase()).toContain("is null");
    } finally {
      sandboxTransactions.implementation = null;
      lock.mockRestore();
      read.mockRestore();
    }
  });

  test("updateAgentProfile purges unverified existing markers while rejecting caller replacements", async () => {
    const managedDiscord = { mode: "cloud-managed", guildId: "server-owned" };
    const managedDiscordGateway = { gatewayId: "server-owned" };
    const managedGithub = { installationId: "server-owned" };
    const existing = {
      ...customSandbox(),
      agent_config: {
        system: "old system",
        [AGENT_CHARACTER_OWNERSHIP_KEY]: "reuse-existing",
        [AGENT_MANAGED_DISCORD_KEY]: managedDiscord,
        [AGENT_MANAGED_DISCORD_GATEWAY_KEY]: managedDiscordGateway,
        [AGENT_MANAGED_GITHUB_KEY]: managedGithub,
        [AGENT_UPGRADED_FROM_KEY]: "personal:real-owner",
        [AGENT_PERSONAL_CUTOVER_KEY]: { mode: "dedicated", sourceAgentId: "personal:real-owner" },
      },
    };
    const tx = installLifecycleUpdateTransaction(existing);
    const { svc, lock, read } = await makeMutableService(existing);
    try {
      await svc.updateAgentProfile(existing.id, existing.organization_id, {
        agentConfig: {
          system: "new system",
          [AGENT_MANAGED_DISCORD_KEY]: { mode: "caller-forged" },
          [AGENT_UPGRADED_FROM_KEY]: "personal:attacker",
          [AGENT_PERSONAL_CUTOVER_KEY]: null,
        },
      });
      expect(tx.updateSet).toHaveBeenCalledWith({
        agent_config: {
          system: "new system",
          [AGENT_CHARACTER_OWNERSHIP_KEY]: "reuse-existing",
          [AGENT_MANAGED_DISCORD_KEY]: managedDiscord,
          [AGENT_MANAGED_DISCORD_GATEWAY_KEY]: managedDiscordGateway,
          [AGENT_MANAGED_GITHUB_KEY]: managedGithub,
        },
        updated_at: expect.any(Date),
      });
    } finally {
      sandboxTransactions.implementation = null;
      lock.mockRestore();
      read.mockRestore();
    }
  });

  test("updateAgentProfile name-only edits preserve unrelated server-owned config", async () => {
    const managedDiscord = { mode: "cloud-managed", guildId: "server-owned" };
    const existing = {
      ...customSandbox(),
      agent_config: {
        system: "old system",
        [AGENT_CHARACTER_OWNERSHIP_KEY]: "reuse-existing",
        [AGENT_MANAGED_DISCORD_KEY]: managedDiscord,
      },
    };
    const tx = installLifecycleUpdateTransaction(existing);
    const { svc, lock, read } = await makeMutableService(existing);
    try {
      await svc.updateAgentProfile(existing.id, existing.organization_id, {
        agentName: "Renamed",
      });
      expect(tx.updateSet).toHaveBeenCalledWith({
        agent_name: "Renamed",
        agent_config: existing.agent_config,
        updated_at: expect.any(Date),
      });
    } finally {
      sandboxTransactions.implementation = null;
      lock.mockRestore();
      read.mockRestore();
    }
  });

  test("updateAgentProfile returns undefined for an unknown/foreign agent and writes nothing", async () => {
    const tx = installLifecycleUpdateTransaction(undefined);
    const { svc, lock, read } = await makeMutableService(undefined);
    try {
      const result = await svc.updateAgentProfile(
        "dddddddd-9999-4999-8999-999999999999",
        "22222222-2222-4222-8222-222222222222",
        { agentName: "Nope" },
      );
      expect(result).toBeUndefined();
      expect(tx.update).not.toHaveBeenCalled();
    } finally {
      sandboxTransactions.implementation = null;
      lock.mockRestore();
      read.mockRestore();
    }
  });

  test("updateAgentProfile with no edits returns the row untouched without writing", async () => {
    const existing = customSandbox();
    const tx = installLifecycleUpdateTransaction(existing);
    const { svc, lock, read } = await makeMutableService(existing);
    try {
      const result = await svc.updateAgentProfile(existing.id, existing.organization_id, {});
      expect(result).toBe(existing);
      expect(tx.update).not.toHaveBeenCalled();
    } finally {
      sandboxTransactions.implementation = null;
      lock.mockRestore();
      read.mockRestore();
    }
  });

  test("updateAgentEnvironment writes through the at-rest encryption boundary under the lifecycle lock", async () => {
    const existing = customSandbox();
    const tx = installLifecycleUpdateTransaction(existing);
    const { svc, lock, read } = await makeMutableService(existing);
    try {
      const result = await svc.updateAgentEnvironment(existing.id, existing.organization_id, {
        MY_FLAG: "on",
      });
      // Without SECRETS_MASTER_KEY the encryptor passes values through
      // (legacy plaintext behavior) — the write must still round through it
      // so configured environments encrypt BYO secrets at rest (#11332).
      expect(tx.updateSet.mock.calls[0]?.[0]).toMatchObject({
        environment_vars: { MY_FLAG: "on" },
        updated_at: expect.any(Date),
      });
      expect(result).toBeDefined();
      if (!result) {
        throw new Error("Expected the updated sandbox environment row");
      }
      expect((result.environment_vars as Record<string, string>).MY_FLAG).toBe("on");
      const whereClause = tx.getWhereClause();
      if (!whereClause) throw new Error("environment update did not build a delete fence");
      const sql = new PgDialect().sqlToQuery(whereClause).sql.toLowerCase();
      expect(sql).toContain("deletion_attempt_id");
      expect(sql).toContain("is null");
    } finally {
      sandboxTransactions.implementation = null;
      lock.mockRestore();
      read.mockRestore();
    }
  });

  test("updateAgentEnvironment returns undefined for an unknown agent and writes nothing", async () => {
    const tx = installLifecycleUpdateTransaction(undefined);
    const { svc, lock, read } = await makeMutableService(undefined);
    try {
      const result = await svc.updateAgentEnvironment(
        "dddddddd-9999-4999-8999-999999999999",
        "22222222-2222-4222-8222-222222222222",
        { MY_FLAG: "on" },
      );
      expect(result).toBeUndefined();
      expect(tx.update).not.toHaveBeenCalled();
    } finally {
      sandboxTransactions.implementation = null;
      lock.mockRestore();
      read.mockRestore();
    }
  });

  test("profile and environment writes reject a durable deletion owner before touching the row", async () => {
    const deleting = {
      ...customSandbox(),
      status: "deletion_pending" as const,
      deletion_attempt_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      deletion_started_at: new Date("2026-07-23T12:30:00.000Z"),
    };
    const tx = installLifecycleUpdateTransaction(deleting);
    const { svc, lock, read } = await makeMutableService(deleting);
    try {
      await expect(
        svc.updateAgentProfile(deleting.id, deleting.organization_id, {
          agentName: "must-not-write",
        }),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        svc.updateAgentEnvironment(deleting.id, deleting.organization_id, {
          MUST_NOT_WRITE: "true",
        }),
      ).rejects.toMatchObject({ status: 409 });
      expect(tx.update).not.toHaveBeenCalled();
    } finally {
      sandboxTransactions.implementation = null;
      lock.mockRestore();
      read.mockRestore();
    }
  });

  test("managed launch mints its replacement on the launch transaction, not a second connection", async () => {
    const existing = customSandbox();
    const tx = installLifecycleUpdateTransaction(existing);
    const { svc, lock, read } = await makeMutableService(existing);
    const mint = spyOn(apiKeysService, "createForAgent").mockResolvedValue({
      apiKey: { id: "replacement-key" },
      plainKey: "eliza_replacement_key",
      revokedKeyHashes: [],
    } as never);
    try {
      await svc.prepareManagedLaunchEnvironment({
        agentId: existing.id,
        organizationId: existing.organization_id,
        userId: existing.user_id,
      });
      // Minting on the global write pool asks for a SECOND connection while
      // this transaction still holds one; concurrent launches then starve the
      // pool and each stalls out at connectionTimeoutMillis.
      expect(mint).toHaveBeenCalledTimes(1);
      expect(mint.mock.calls[0][0]).toMatchObject({
        agentSandboxId: existing.id,
        organizationId: existing.organization_id,
        tx: tx.handle,
      });
    } finally {
      sandboxTransactions.implementation = null;
      lock.mockRestore();
      read.mockRestore();
      mint.mockRestore();
    }
  });

  test("managed launch unwinds the credential rotation when its environment CAS loses", async () => {
    const existing = customSandbox();
    const tx = installLifecycleUpdateTransaction(existing, { persist: false });
    const { svc, lock, read } = await makeMutableService(existing);
    const mint = spyOn(apiKeysService, "createForAgent").mockResolvedValue({
      apiKey: { id: "replacement-key" },
      plainKey: "eliza_replacement_key",
      revokedKeyHashes: [],
    } as never);
    const revoke = spyOn(apiKeysService, "revokeForAgent").mockResolvedValue(undefined);
    try {
      await expect(
        svc.prepareManagedLaunchEnvironment({
          agentId: existing.id,
          organizationId: existing.organization_id,
          userId: existing.user_id,
        }),
      ).resolves.toBeUndefined();
      expect(mint).toHaveBeenCalledTimes(1);
      // The rotation shares this transaction, so losing the CAS rolls it back.
      // A compensating out-of-band revoke would now delete the RESTORED key and
      // leave the agent with none.
      expect(revoke).not.toHaveBeenCalled();
      expect(tx.update).toHaveBeenCalledTimes(1);
      const whereClause = tx.getWhereClause();
      if (!whereClause) throw new Error("managed launch did not build its ownership CAS");
      const sql = new PgDialect().sqlToQuery(whereClause).sql.toLowerCase();
      expect(sql).toContain("deletion_attempt_id");
      expect(sql).toContain("environment_revision");
      expect(sql).toContain("lifecycle_revision");
      expect(sql).not.toContain("updated_at");
      expect(sql).toContain("claimed_at");
    } finally {
      sandboxTransactions.implementation = null;
      lock.mockRestore();
      read.mockRestore();
      mint.mockRestore();
      revoke.mockRestore();
    }
  });

  test("managed launch never mints when deletion already owns the lifecycle", async () => {
    const deleting = {
      ...customSandbox(),
      status: "deletion_pending" as const,
      deletion_attempt_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      deletion_started_at: new Date("2026-07-23T12:30:00.000Z"),
    };
    const tx = installLifecycleUpdateTransaction(deleting);
    const { svc, lock, read } = await makeMutableService(deleting);
    const mint = spyOn(apiKeysService, "createForAgent");
    const revoke = spyOn(apiKeysService, "revokeForAgent");
    try {
      await expect(
        svc.prepareManagedLaunchEnvironment({
          agentId: deleting.id,
          organizationId: deleting.organization_id,
          userId: deleting.user_id,
        }),
      ).resolves.toBeUndefined();
      expect(mint).not.toHaveBeenCalled();
      expect(revoke).not.toHaveBeenCalled();
      expect(tx.update).not.toHaveBeenCalled();
    } finally {
      sandboxTransactions.implementation = null;
      lock.mockRestore();
      read.mockRestore();
      mint.mockRestore();
      revoke.mockRestore();
    }
  });

  for (const executionTier of ["shared", "future-container-tier"] as const) {
    test(`managed launch rejects ${executionTier} under the lock before mint or environment CAS`, async () => {
      const existing: AgentSandbox = {
        ...customSandbox(),
        execution_tier: executionTier as AgentSandbox["execution_tier"],
      };
      const tx = installLifecycleUpdateTransaction(existing);
      const { svc, lock, read } = await makeMutableService(existing);
      const mint = spyOn(apiKeysService, "createForAgent");
      const revoke = spyOn(apiKeysService, "revokeForAgent");
      try {
        await expect(
          svc.prepareManagedLaunchEnvironment({
            agentId: existing.id,
            organizationId: existing.organization_id,
            userId: existing.user_id,
          }),
        ).rejects.toThrow("requires a container-backed execution tier");
        expect(mint).not.toHaveBeenCalled();
        expect(revoke).not.toHaveBeenCalled();
        expect(tx.update).not.toHaveBeenCalled();
      } finally {
        sandboxTransactions.implementation = null;
        lock.mockRestore();
        read.mockRestore();
        mint.mockRestore();
        revoke.mockRestore();
      }
    });
  }
});

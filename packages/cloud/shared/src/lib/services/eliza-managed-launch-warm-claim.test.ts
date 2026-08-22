/**
 * Proves managed launch cannot rotate a claimed container's server-attested
 * credential while its durable handoff fence is incomplete.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  type AgentSandbox,
  CONTAINER_BACKED_EXECUTION_TIERS,
} from "../../db/schemas/agent-sandboxes";
import { cache } from "../cache/client";
import { apiKeysService } from "./api-keys";
import {
  launchManagedElizaAgent,
  ManagedElizaLaunchError,
  readManagedElizaAgentConnection,
} from "./eliza-managed-launch";
import { elizaSandboxService } from "./eliza-sandbox";

const AGENT_ID = "00000000-0000-4000-8000-000000000111";
const ORG_ID = "00000000-0000-4000-8000-000000000112";
const USER_ID = "00000000-0000-4000-8000-000000000113";
const originalFetch = globalThis.fetch;

function claimedSandbox(
  state: "pending" | "attested" | "ready" | "failed",
  environmentRevision = 4,
  attestedRevision: number | null = state === "ready" ? 4 : null,
): AgentSandbox {
  return {
    id: AGENT_ID,
    organization_id: ORG_ID,
    user_id: USER_ID,
    agent_name: "Claimed Agent",
    status: state === "ready" ? "running" : "provisioning",
    execution_tier: "dedicated-lazy",
    pool_status: null,
    deleted_at: null,
    deletion_attempt_id: null,
    claimed_at: new Date("2026-07-23T00:00:00.000Z"),
    environment_vars: {
      ELIZA_API_TOKEN: "transport-token",
      ELIZAOS_CLOUD_API_KEY: "eliza_attested_key",
    },
    environment_revision: environmentRevision,
    warm_claim_credential_state: state,
    warm_claim_source_pool_id: state === "ready" ? null : AGENT_ID,
    warm_claim_key_fingerprint: state === "ready" ? "attestedattested" : null,
    warm_claim_attested_at: state === "ready" ? new Date("2026-07-23T00:00:01.000Z") : null,
    warm_claim_attested_environment_revision: attestedRevision,
    warm_claim_cleanup_completed_at: null,
    health_url: "https://agent.example/api",
  } as unknown as AgentSandbox;
}

function genericSandbox(status: "running" | "stopped"): AgentSandbox {
  return {
    ...claimedSandbox("ready"),
    agent_name: "Generic Agent",
    status,
    claimed_at: null,
    warm_claim_credential_state: null,
    warm_claim_key_fingerprint: null,
    warm_claim_attested_at: null,
    warm_claim_attested_environment_revision: null,
    health_url: status === "running" ? "https://old-agent.example" : null,
  } as unknown as AgentSandbox;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("managed launch container authority", () => {
  test("ineligible rows fail before lifecycle, credential, network, or cache effects", async () => {
    const ineligible = [
      {
        label: "shared tier",
        sandbox: { ...genericSandbox("running"), execution_tier: "shared" } as AgentSandbox,
        message: "Managed launch requires a container-backed execution tier",
      },
      {
        label: "unknown tier",
        sandbox: {
          ...genericSandbox("running"),
          execution_tier: "future-container-tier",
        } as unknown as AgentSandbox,
        message: "Managed launch requires a container-backed execution tier",
      },
      {
        label: "pool-owned capacity",
        sandbox: { ...genericSandbox("running"), pool_status: "unclaimed" } as AgentSandbox,
        message: "Managed launch cannot target pool-owned capacity",
      },
      {
        label: "soft-deleted agent",
        sandbox: {
          ...genericSandbox("running"),
          deleted_at: new Date("2026-07-23T01:00:00.000Z"),
        } as AgentSandbox,
        message: "Managed launch cannot target a deleted agent",
      },
      {
        label: "deletion-owned agent",
        sandbox: {
          ...genericSandbox("running"),
          deletion_attempt_id: "00000000-0000-4000-8000-000000000114",
        } as AgentSandbox,
        message: "Managed launch cannot start while agent deletion is in progress",
      },
    ];
    const getAgentForWrite = spyOn(elizaSandboxService, "getAgentForWrite");
    const shutdown = spyOn(elizaSandboxService, "shutdown");
    const prepare = spyOn(elizaSandboxService, "prepareManagedLaunchEnvironment");
    const provision = spyOn(elizaSandboxService, "provision");
    const createKey = spyOn(apiKeysService, "createForAgent");
    const cacheAvailable = spyOn(cache, "isAvailable");
    const cacheSet = spyOn(cache, "set");
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("fetch must remain behind the managed-launch authority guard");
    }) as typeof fetch;
    try {
      for (const scenario of ineligible) {
        getAgentForWrite.mockResolvedValueOnce(scenario.sandbox);
        const error = await launchManagedElizaAgent({
          agentId: AGENT_ID,
          organizationId: ORG_ID,
          userId: USER_ID,
        }).catch((caught) => caught);

        expect(error, scenario.label).toBeInstanceOf(ManagedElizaLaunchError);
        expect((error as ManagedElizaLaunchError).status, scenario.label).toBe(409);
        expect((error as ManagedElizaLaunchError).message, scenario.label).toBe(scenario.message);
      }

      expect(getAgentForWrite).toHaveBeenCalledTimes(ineligible.length);
      expect(shutdown).not.toHaveBeenCalled();
      expect(prepare).not.toHaveBeenCalled();
      expect(provision).not.toHaveBeenCalled();
      expect(createKey).not.toHaveBeenCalled();
      expect(fetchCalls).toBe(0);
      expect(cacheAvailable).not.toHaveBeenCalled();
      expect(cacheSet).not.toHaveBeenCalled();
    } finally {
      getAgentForWrite.mockRestore();
      shutdown.mockRestore();
      prepare.mockRestore();
      provision.mockRestore();
      createKey.mockRestore();
      cacheAvailable.mockRestore();
      cacheSet.mockRestore();
    }
  });

  test("every canonical container tier reaches the next lifecycle barrier", async () => {
    const getAgentForWrite = spyOn(elizaSandboxService, "getAgentForWrite");
    const shutdown = spyOn(elizaSandboxService, "shutdown").mockResolvedValue({
      success: false,
      error: "Simulated lifecycle barrier after launch authority",
    });
    const prepare = spyOn(elizaSandboxService, "prepareManagedLaunchEnvironment");
    const provision = spyOn(elizaSandboxService, "provision");
    try {
      for (const executionTier of CONTAINER_BACKED_EXECUTION_TIERS) {
        getAgentForWrite.mockResolvedValueOnce({
          ...genericSandbox("running"),
          execution_tier: executionTier,
        } as AgentSandbox);
        const error = await launchManagedElizaAgent({
          agentId: AGENT_ID,
          organizationId: ORG_ID,
          userId: USER_ID,
        }).catch((caught) => caught);

        expect(error).toBeInstanceOf(ManagedElizaLaunchError);
        expect((error as ManagedElizaLaunchError).status).toBe(409);
        expect((error as ManagedElizaLaunchError).message).toBe(
          "Simulated lifecycle barrier after launch authority",
        );
      }

      expect(shutdown).toHaveBeenCalledTimes(CONTAINER_BACKED_EXECUTION_TIERS.length);
      expect(prepare).not.toHaveBeenCalled();
      expect(provision).not.toHaveBeenCalled();
    } finally {
      getAgentForWrite.mockRestore();
      shutdown.mockRestore();
      prepare.mockRestore();
      provision.mockRestore();
    }
  });
});

describe("managed launch warm-claim credential boundary", () => {
  test("pending and stale-revision claims fail before any key rotation or provision", async () => {
    const createKey = spyOn(apiKeysService, "createForAgent");
    const provision = spyOn(elizaSandboxService, "provision");
    const getAgentForWrite = spyOn(elizaSandboxService, "getAgentForWrite")
      .mockResolvedValueOnce(claimedSandbox("pending"))
      .mockResolvedValueOnce(claimedSandbox("ready", 5, 4));
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const error = await launchManagedElizaAgent({
          agentId: AGENT_ID,
          organizationId: ORG_ID,
          userId: USER_ID,
        }).catch((caught) => caught);
        expect(error).toBeInstanceOf(ManagedElizaLaunchError);
        expect((error as ManagedElizaLaunchError).status).toBe(409);
      }
      expect(createKey).not.toHaveBeenCalled();
      expect(provision).not.toHaveBeenCalled();
    } finally {
      createKey.mockRestore();
      provision.mockRestore();
      getAgentForWrite.mockRestore();
    }
  });

  test("ready current-revision claims reuse the attested key without minting", async () => {
    const getAgentForWrite = spyOn(elizaSandboxService, "getAgentForWrite").mockResolvedValue(
      claimedSandbox("ready"),
    );
    const createKey = spyOn(apiKeysService, "createForAgent");
    const cacheAvailable = spyOn(cache, "isAvailable").mockReturnValue(true);
    const cacheSet = spyOn(cache, "set").mockResolvedValue(undefined);
    const requests: Array<{ url: string; authorization: string | null }> = [];
    globalThis.fetch = (async (input, init) => {
      requests.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return Response.json({ complete: true });
    }) as typeof fetch;
    try {
      const result = await launchManagedElizaAgent({
        agentId: AGENT_ID,
        organizationId: ORG_ID,
        userId: USER_ID,
      });
      expect(result.connection.token).toBe("transport-token");
      expect(createKey).not.toHaveBeenCalled();
      expect(requests).toEqual([
        {
          url: "https://agent.example/api/api/onboarding/status",
          authorization: "Bearer transport-token",
        },
      ]);
    } finally {
      getAgentForWrite.mockRestore();
      createKey.mockRestore();
      cacheAvailable.mockRestore();
      cacheSet.mockRestore();
    }
  });
});

describe("managed launch credential rotation ordering", () => {
  test("read-only lookup rejects running claims without a current credential attestation", async () => {
    const blockedClaims = [
      claimedSandbox("pending"),
      claimedSandbox("attested"),
      claimedSandbox("failed"),
      claimedSandbox("ready", 5, 4),
    ].map((sandbox) => ({ ...sandbox, status: "running" }) as AgentSandbox);
    const getAgent = spyOn(elizaSandboxService, "getAgent");
    const shutdown = spyOn(elizaSandboxService, "shutdown");
    const prepare = spyOn(elizaSandboxService, "prepareManagedLaunchEnvironment");
    const provision = spyOn(elizaSandboxService, "provision");
    try {
      for (const sandbox of blockedClaims) {
        getAgent.mockResolvedValueOnce(sandbox);
        const error = await readManagedElizaAgentConnection({
          agentId: AGENT_ID,
          organizationId: ORG_ID,
        }).catch((caught) => caught);

        expect(error).toBeInstanceOf(ManagedElizaLaunchError);
        expect((error as ManagedElizaLaunchError).status).toBe(409);
      }
      expect(shutdown).not.toHaveBeenCalled();
      expect(prepare).not.toHaveBeenCalled();
      expect(provision).not.toHaveBeenCalled();
    } finally {
      getAgent.mockRestore();
      shutdown.mockRestore();
      prepare.mockRestore();
      provision.mockRestore();
    }
  });

  test("read-only lookup accepts a running claim with a current credential attestation", async () => {
    const getAgent = spyOn(elizaSandboxService, "getAgent").mockResolvedValue(
      claimedSandbox("ready"),
    );
    const shutdown = spyOn(elizaSandboxService, "shutdown");
    const prepare = spyOn(elizaSandboxService, "prepareManagedLaunchEnvironment");
    const provision = spyOn(elizaSandboxService, "provision");
    try {
      await expect(
        readManagedElizaAgentConnection({
          agentId: AGENT_ID,
          organizationId: ORG_ID,
        }),
      ).resolves.toEqual({
        apiBase: "https://agent.example/api",
        token: "transport-token",
      });
      expect(shutdown).not.toHaveBeenCalled();
      expect(prepare).not.toHaveBeenCalled();
      expect(provision).not.toHaveBeenCalled();
    } finally {
      getAgent.mockRestore();
      shutdown.mockRestore();
      prepare.mockRestore();
      provision.mockRestore();
    }
  });

  test("read-only connection lookup never touches lifecycle collaborators", async () => {
    const running = genericSandbox("running");
    const getAgent = spyOn(elizaSandboxService, "getAgent").mockResolvedValue(running);
    const shutdown = spyOn(elizaSandboxService, "shutdown");
    const prepare = spyOn(elizaSandboxService, "prepareManagedLaunchEnvironment");
    const provision = spyOn(elizaSandboxService, "provision");
    try {
      const connection = await readManagedElizaAgentConnection({
        agentId: AGENT_ID,
        organizationId: ORG_ID,
      });

      expect(connection).toEqual({
        apiBase: "https://old-agent.example",
        token: "transport-token",
      });
      expect(shutdown).not.toHaveBeenCalled();
      expect(prepare).not.toHaveBeenCalled();
      expect(provision).not.toHaveBeenCalled();
    } finally {
      getAgent.mockRestore();
      shutdown.mockRestore();
      prepare.mockRestore();
      provision.mockRestore();
    }
  });

  test("a refused shutdown leaves the running credential untouched", async () => {
    const running = genericSandbox("running");
    const getAgentForWrite = spyOn(elizaSandboxService, "getAgentForWrite").mockResolvedValue(
      running,
    );
    const shutdown = spyOn(elizaSandboxService, "shutdown").mockResolvedValue({
      success: false,
      error: "Refusing to stop without a current backup",
    });
    const prepare = spyOn(elizaSandboxService, "prepareManagedLaunchEnvironment");
    const provision = spyOn(elizaSandboxService, "provision");
    try {
      const error = await launchManagedElizaAgent({
        agentId: AGENT_ID,
        organizationId: ORG_ID,
        userId: USER_ID,
      }).catch((caught) => caught);

      expect(error).toBeInstanceOf(ManagedElizaLaunchError);
      expect((error as ManagedElizaLaunchError).status).toBe(409);
      expect(shutdown).toHaveBeenCalledTimes(1);
      expect(prepare).not.toHaveBeenCalled();
      expect(provision).not.toHaveBeenCalled();
    } finally {
      getAgentForWrite.mockRestore();
      shutdown.mockRestore();
      prepare.mockRestore();
      provision.mockRestore();
    }
  });

  test("stops a running generation before rotating and provisioning its replacement", async () => {
    const running = genericSandbox("running");
    const stopped = genericSandbox("stopped");
    const replacement = {
      ...genericSandbox("running"),
      health_url: "https://new-agent.example",
    } as AgentSandbox;
    const order: string[] = [];
    const getAgentForWrite = spyOn(elizaSandboxService, "getAgentForWrite").mockResolvedValue(
      running,
    );
    const getAgent = spyOn(elizaSandboxService, "getAgent").mockResolvedValue(stopped);
    const shutdown = spyOn(elizaSandboxService, "shutdown").mockImplementation(async () => {
      order.push("shutdown");
      return { success: true };
    });
    const prepare = spyOn(
      elizaSandboxService,
      "prepareManagedLaunchEnvironment",
    ).mockImplementation(async () => {
      order.push("rotate");
      return {
        sandbox: stopped,
        environment: {
          apiToken: "replacement-transport-token",
          agentApiKey: "eliza_replacement_key",
          changed: true,
          environmentVars: {},
          revokedKeyHashes: [],
        },
      };
    });
    const provision = spyOn(elizaSandboxService, "provision").mockImplementation(async () => {
      order.push("provision");
      return { success: true, sandboxRecord: replacement } as never;
    });
    const cacheAvailable = spyOn(cache, "isAvailable").mockReturnValue(true);
    const cacheSet = spyOn(cache, "set").mockResolvedValue(undefined);
    globalThis.fetch = (async () => Response.json({ complete: true })) as typeof fetch;
    try {
      const result = await launchManagedElizaAgent({
        agentId: AGENT_ID,
        organizationId: ORG_ID,
        userId: USER_ID,
      });

      expect(order).toEqual(["shutdown", "rotate", "provision"]);
      expect(result.connection.token).toBe("replacement-transport-token");
    } finally {
      getAgentForWrite.mockRestore();
      getAgent.mockRestore();
      shutdown.mockRestore();
      prepare.mockRestore();
      provision.mockRestore();
      cacheAvailable.mockRestore();
      cacheSet.mockRestore();
    }
  });
});

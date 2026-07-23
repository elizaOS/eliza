/**
 * Proves managed launch cannot rotate a claimed container's server-attested
 * credential while its durable handoff fence is incomplete.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { AgentSandbox } from "../../db/schemas/agent-sandboxes";
import { cache } from "../cache/client";
import { apiKeysService } from "./api-keys";
import { launchManagedElizaAgent, ManagedElizaLaunchError } from "./eliza-managed-launch";
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

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("managed launch warm-claim credential boundary", () => {
  test("pending and stale-revision claims fail before any key rotation or provision", async () => {
    const createKey = spyOn(apiKeysService, "createForAgent");
    const provision = spyOn(elizaSandboxService, "provision");
    const getAgent = spyOn(elizaSandboxService, "getAgent")
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
      getAgent.mockRestore();
    }
  });

  test("ready current-revision claims reuse the attested key without minting", async () => {
    const getAgent = spyOn(elizaSandboxService, "getAgent").mockResolvedValue(
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
      getAgent.mockRestore();
      createKey.mockRestore();
      cacheAvailable.mockRestore();
      cacheSet.mockRestore();
    }
  });
});

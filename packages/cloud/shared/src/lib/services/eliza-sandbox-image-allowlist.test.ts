/**
 * H1 (#12230): the managed-agent lane must gate a caller-supplied `dockerImage`
 * against the agent image allowlist BEFORE any DB write or `docker pull`.
 *
 * `POST /api/v1/eliza/agents` used to accept an arbitrary `dockerImage`
 * (permissive regex only) and forward it straight to provisioning. The gate now
 * lives in the SHARED `createAgent` path so every route inherits it. These tests
 * drive the real gate (`assertAgentImageAllowed`) and the real `createAgent`
 * reject path (which throws before touching the DB).
 */

import { describe, expect, test } from "bun:test";
import { runWithCloudBindings } from "../runtime/cloud-bindings";
import {
  AgentImageNotAllowedError,
  assertAgentImageAllowed,
  elizaSandboxService,
} from "./eliza-sandbox";

describe("assertAgentImageAllowed (H1 gate)", () => {
  test("no image → no-op (default first-party image used downstream)", () => {
    runWithCloudBindings({}, () => {
      expect(() => assertAgentImageAllowed(undefined)).not.toThrow();
      expect(() => assertAgentImageAllowed("")).not.toThrow();
    });
  });

  test("default allowlist permits the first-party elizaos namespace", () => {
    runWithCloudBindings({}, () => {
      expect(() => assertAgentImageAllowed("ghcr.io/elizaos/eliza:stable")).not.toThrow();
    });
  });

  test("default allowlist rejects arbitrary third-party images", () => {
    runWithCloudBindings({}, () => {
      expect(() => assertAgentImageAllowed("docker.io/library/nginx:latest")).toThrow(
        AgentImageNotAllowedError,
      );
      expect(() => assertAgentImageAllowed("ghcr.io/attacker/evil:latest")).toThrow(
        AgentImageNotAllowedError,
      );
    });
  });

  test("default allowlist does NOT inherit the coding lane's BYO namespaces", () => {
    // The coding-container allowlist includes dexploarer/waifufun; the managed
    // agent lane must NOT — it ships only the first-party runtime image.
    runWithCloudBindings({}, () => {
      expect(() => assertAgentImageAllowed("ghcr.io/dexploarer/bnancy:latest")).toThrow(
        AgentImageNotAllowedError,
      );
      expect(() => assertAgentImageAllowed("ghcr.io/waifufun/runner:v2")).toThrow(
        AgentImageNotAllowedError,
      );
    });
  });

  test("operator env override widens the allowlist", () => {
    runWithCloudBindings({ AGENT_IMAGE_ALLOWLIST: "ghcr.io/approved/*" }, () => {
      expect(() => assertAgentImageAllowed("ghcr.io/approved/thing:1")).not.toThrow();
      // The default elizaos entry is REPLACED, not merged, by an explicit env.
      expect(() => assertAgentImageAllowed("ghcr.io/elizaos/eliza:stable")).toThrow(
        AgentImageNotAllowedError,
      );
    });
  });

  test("an explicit all-empty-entries env denies every image (fail-closed)", () => {
    // A configured-but-empty allowlist (only separators) parses to `[]`, and
    // `isCodingContainerImageAllowed([])` is fail-closed — nothing is permitted,
    // not even the first-party image.
    runWithCloudBindings({ AGENT_IMAGE_ALLOWLIST: " , , " }, () => {
      expect(() => assertAgentImageAllowed("ghcr.io/elizaos/eliza:stable")).toThrow(
        AgentImageNotAllowedError,
      );
    });
  });

  test("digest-pin gate rejects a mutable tag when armed", () => {
    runWithCloudBindings(
      {
        CONTAINER_IMAGE_REQUIRE_DIGEST: "true",
      },
      () => {
        let thrown: unknown;
        try {
          assertAgentImageAllowed("ghcr.io/elizaos/eliza:latest");
        } catch (e) {
          thrown = e;
        }
        expect(thrown).toBeInstanceOf(AgentImageNotAllowedError);
        expect((thrown as AgentImageNotAllowedError).reason).toBe("not_digest_pinned");
      },
    );
  });

  test("digest-pin gate accepts a fully pinned digest when armed", () => {
    const pinned = `ghcr.io/elizaos/eliza@sha256:${"a".repeat(64)}`;
    runWithCloudBindings({ CONTAINER_IMAGE_REQUIRE_DIGEST: "true" }, () => {
      expect(() => assertAgentImageAllowed(pinned)).not.toThrow();
    });
  });
});

describe("createAgent rejects a non-allowlisted image before provisioning (H1)", () => {
  test("throws AgentImageNotAllowedError and never reaches the DB", async () => {
    // The gate is the FIRST statement in createAgent, so a non-allowlisted image
    // rejects before any encryption / DB transaction. A rejection here therefore
    // proves nothing was provisioned. If the gate were missing this call would
    // instead fail deep in the DB layer (a different error), so the assertion on
    // the error TYPE is load-bearing.
    await runWithCloudBindings({}, async () => {
      await expect(
        elizaSandboxService.createAgent({
          organizationId: "11111111-1111-1111-1111-111111111111",
          userId: "22222222-2222-2222-2222-222222222222",
          agentName: "evil",
          dockerImage: "docker.io/library/nginx:latest",
        }),
      ).rejects.toBeInstanceOf(AgentImageNotAllowedError);
    });
  });
});

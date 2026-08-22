/** Primary-DB proofs for Robot/Cloud source resolution and boot CAS fencing. */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";

import { pushSchema } from "drizzle-kit/api";
import { installAgentNodeOccurrenceTriggerForTests } from "../../agent-node-occurrence-test-support";
import { closeDatabaseConnectionsForTests, dbWrite } from "../../client";
import { agentNodeIncarnationHistories } from "../../schemas/agent-node-incarnation-histories";
import { dockerNodes } from "../../schemas/docker-nodes";
import {
  AgentBackupSourceAuthorityError,
  parseLinuxBootId,
  resolveAgentBackupManifestSourceAuthority,
} from "../agent-backup-source-authority";
import { dockerNodesRepository } from "../docker-nodes";

const PGLITE_TIMEOUT = 60_000;
const ROBOT_RECORD_ID = "00000000-0000-4000-8000-000000000101";
const CLOUD_RECORD_ID = "00000000-0000-4000-8000-000000000102";
const BOOT_A = "00000000-0000-4000-8000-000000000111";
const BOOT_B = "00000000-0000-4000-8000-000000000112";
const BOOT_C = "00000000-0000-4000-8000-000000000113";
const BOOT_WITH_LETTERS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const CONTAINER_ID = "a".repeat(64);

let schemaFailure = "";

function registration(hostname = "robot.example.test") {
  return {
    hostname,
    sshPort: 22,
    sshUser: "root",
    capacity: 8,
    status: "unknown" as const,
    hostKeyFingerprint: "robot-host-key",
    metadata: { provider: "operator-onboarded" },
  };
}

beforeAll(async () => {
  try {
    const { apply } = await pushSchema(
      { agentNodeIncarnationHistories, dockerNodes } as never,
      dbWrite as never,
    );
    await apply();
    await installAgentNodeOccurrenceTriggerForTests((statement) => dbWrite.execute(statement));
  } catch (error) {
    schemaFailure = error instanceof Error ? error.message : String(error);
  }
}, PGLITE_TIMEOUT);

beforeEach(async () => {
  expect(schemaFailure).toBe("");
  await dbWrite.delete(dockerNodes);
  await dbWrite.delete(agentNodeIncarnationHistories);
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

describe("agent backup source authority on primary PGlite", () => {
  test("parses one exact lowercase Linux boot UUID", () => {
    expect(parseLinuxBootId(`${BOOT_A}\n`)).toBe(BOOT_A);
    expect(() => parseLinuxBootId(BOOT_WITH_LETTERS.toUpperCase())).toThrow(/lowercase UUID/);
    expect(() => parseLinuxBootId(`${BOOT_A}\n${BOOT_B}`)).toThrow(/lowercase UUID/);
  });

  test("never promotes metadata-shaped legacy rows or aliases record and node handles", async () => {
    await dbWrite.insert(dockerNodes).values({
      id: ROBOT_RECORD_ID,
      node_id: "robot-runtime-1",
      hostname: "robot.example.test",
      host_key_fingerprint: "robot-host-key",
      metadata: { provider: "operator-onboarded", fleet: "robot" },
    });

    await expect(
      resolveAgentBackupManifestSourceAuthority({
        nodeRecordId: ROBOT_RECORD_ID,
        nodeId: "robot-runtime-1",
        nodeIncarnation: BOOT_A,
        containerId: CONTAINER_ID,
      }),
    ).rejects.toThrow(/legacy|unattested|stale/);
    await expect(
      resolveAgentBackupManifestSourceAuthority({
        nodeRecordId: CLOUD_RECORD_ID,
        nodeId: ROBOT_RECORD_ID,
        nodeIncarnation: BOOT_A,
        containerId: CONTAINER_ID,
      }),
    ).rejects.toBeInstanceOf(AgentBackupSourceAuthorityError);
  });

  test(
    "explicit Robot onboarding is idempotent and reboot rotation is stale-safe",
    async () => {
      await dbWrite.insert(dockerNodes).values({
        id: ROBOT_RECORD_ID,
        node_id: "robot-runtime-1",
        hostname: "old.example.test",
        host_key_fingerprint: "robot-host-key",
      });

      const promoted = await dockerNodesRepository.attestRobotSourceAuthority({
        id: ROBOT_RECORD_ID,
        nodeId: "robot-runtime-1",
        expectedIncarnation: null,
        expectedHostKeyFingerprint: "robot-host-key",
        observedIncarnation: BOOT_A,
        registration: registration(),
      });
      expect(promoted).toMatchObject({
        fleet_kind: "robot",
        infrastructure_provider: "hetzner",
        provider_server_id: null,
        node_incarnation: BOOT_A,
        hostname: "robot.example.test",
      });

      const replay = await dockerNodesRepository.attestRobotSourceAuthority({
        id: ROBOT_RECORD_ID,
        nodeId: "robot-runtime-1",
        expectedIncarnation: BOOT_A,
        expectedHostKeyFingerprint: "robot-host-key",
        observedIncarnation: BOOT_A,
        registration: registration("robot-renamed.example.test"),
      });
      expect(replay.node_incarnation).toBe(BOOT_A);
      expect(replay.hostname).toBe("robot-renamed.example.test");

      const rebooted = await dockerNodesRepository.attestNodeIncarnation({
        id: ROBOT_RECORD_ID,
        nodeId: "robot-runtime-1",
        expectedIncarnation: BOOT_A,
        expectedHostKeyFingerprint: "robot-host-key",
        observedIncarnation: BOOT_B,
      });
      expect(rebooted.node_incarnation).toBe(BOOT_B);
      await expect(
        dockerNodesRepository.attestNodeIncarnation({
          id: ROBOT_RECORD_ID,
          nodeId: "robot-runtime-1",
          expectedIncarnation: BOOT_A,
          expectedHostKeyFingerprint: "robot-host-key",
          observedIncarnation: BOOT_C,
        }),
      ).rejects.toThrow(/compare-and-swap/);
      expect((await dockerNodesRepository.findById(ROBOT_RECORD_ID))?.node_incarnation).toBe(
        BOOT_B,
      );

      await expect(
        resolveAgentBackupManifestSourceAuthority({
          nodeRecordId: ROBOT_RECORD_ID,
          nodeId: "robot-runtime-1",
          nodeIncarnation: BOOT_A,
          containerId: CONTAINER_ID,
        }),
      ).rejects.toThrow(/stale/);
      await expect(
        resolveAgentBackupManifestSourceAuthority({
          nodeRecordId: ROBOT_RECORD_ID,
          nodeId: "robot-runtime-1",
          nodeIncarnation: BOOT_B,
          containerId: CONTAINER_ID,
        }),
      ).resolves.toEqual({
        kind: "robot",
        provider: "hetzner",
        nodeRecordId: ROBOT_RECORD_ID,
        nodeIncarnation: BOOT_B,
        nodeId: "robot-runtime-1",
        containerId: CONTAINER_ID,
      });
    },
    PGLITE_TIMEOUT,
  );

  test(
    "stale invalidation cannot erase a newer boot and exact invalidation fails closed",
    async () => {
      await dbWrite.insert(dockerNodes).values({
        id: ROBOT_RECORD_ID,
        node_id: "robot-runtime-1",
        hostname: "robot.example.test",
        host_key_fingerprint: "robot-host-key",
        fleet_kind: "robot",
        infrastructure_provider: "hetzner",
        node_incarnation: BOOT_B,
      });

      await expect(
        dockerNodesRepository.invalidateNodeIncarnation({
          id: ROBOT_RECORD_ID,
          nodeId: "robot-runtime-1",
          expectedIncarnation: BOOT_A,
          expectedHostKeyFingerprint: "robot-host-key",
        }),
      ).rejects.toThrow(/compare-and-swap/);
      expect((await dockerNodesRepository.findById(ROBOT_RECORD_ID))?.node_incarnation).toBe(
        BOOT_B,
      );

      await dockerNodesRepository.invalidateNodeIncarnation({
        id: ROBOT_RECORD_ID,
        nodeId: "robot-runtime-1",
        expectedIncarnation: BOOT_B,
        expectedHostKeyFingerprint: "robot-host-key",
      });
      await expect(
        resolveAgentBackupManifestSourceAuthority({
          nodeRecordId: ROBOT_RECORD_ID,
          nodeId: "robot-runtime-1",
          nodeIncarnation: BOOT_B,
          containerId: CONTAINER_ID,
        }),
      ).rejects.toThrow(/unattested|stale/);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "host-key rotation atomically revokes capture authority until the new pin re-attests",
    async () => {
      await dbWrite.insert(dockerNodes).values({
        id: ROBOT_RECORD_ID,
        node_id: "robot-runtime-1",
        hostname: "robot.example.test",
        host_key_fingerprint: "old-host-key",
        fleet_kind: "robot",
        infrastructure_provider: "hetzner",
        node_incarnation: BOOT_A,
      });

      await expect(
        resolveAgentBackupManifestSourceAuthority({
          nodeRecordId: ROBOT_RECORD_ID,
          nodeId: "robot-runtime-1",
          nodeIncarnation: BOOT_A,
          containerId: CONTAINER_ID,
        }),
      ).resolves.toMatchObject({ nodeIncarnation: BOOT_A });

      const rotated = await dockerNodesRepository.rotateNodeHostKeyFingerprint({
        id: ROBOT_RECORD_ID,
        nodeId: "robot-runtime-1",
        expectedFingerprint: "old-host-key",
        observedFingerprint: "new-host-key",
      });
      expect(rotated).toMatchObject({
        host_key_fingerprint: "new-host-key",
        node_incarnation: null,
      });
      await expect(
        resolveAgentBackupManifestSourceAuthority({
          nodeRecordId: ROBOT_RECORD_ID,
          nodeId: "robot-runtime-1",
          nodeIncarnation: BOOT_A,
          containerId: CONTAINER_ID,
        }),
      ).rejects.toThrow(/unattested|stale/);

      await expect(
        dockerNodesRepository.attestNodeIncarnation({
          id: ROBOT_RECORD_ID,
          nodeId: "robot-runtime-1",
          expectedIncarnation: null,
          expectedHostKeyFingerprint: "old-host-key",
          observedIncarnation: BOOT_B,
        }),
      ).rejects.toThrow(/compare-and-swap/);

      await dockerNodesRepository.attestNodeIncarnation({
        id: ROBOT_RECORD_ID,
        nodeId: "robot-runtime-1",
        expectedIncarnation: null,
        expectedHostKeyFingerprint: "new-host-key",
        observedIncarnation: BOOT_B,
      });
      await expect(
        resolveAgentBackupManifestSourceAuthority({
          nodeRecordId: ROBOT_RECORD_ID,
          nodeId: "robot-runtime-1",
          nodeIncarnation: BOOT_B,
          containerId: CONTAINER_ID,
        }),
      ).resolves.toMatchObject({ nodeIncarnation: BOOT_B });
    },
    PGLITE_TIMEOUT,
  );

  test(
    "keeps exact Robot and Cloud source variants disjoint",
    async () => {
      await dbWrite.insert(dockerNodes).values({
        id: CLOUD_RECORD_ID,
        node_id: "cloud-runtime-1",
        hostname: "cloud.example.test",
        host_key_fingerprint: "cloud-host-key",
        fleet_kind: "cloud",
        infrastructure_provider: "hetzner",
        provider_server_id: "4242",
        node_incarnation: BOOT_C,
      });

      await expect(
        resolveAgentBackupManifestSourceAuthority({
          nodeRecordId: CLOUD_RECORD_ID,
          nodeId: "cloud-runtime-1",
          nodeIncarnation: BOOT_C,
          containerId: CONTAINER_ID,
        }),
      ).resolves.toEqual({
        kind: "cloud",
        provider: "hetzner",
        nodeRecordId: CLOUD_RECORD_ID,
        nodeIncarnation: BOOT_C,
        nodeId: "cloud-runtime-1",
        containerId: CONTAINER_ID,
        providerServerId: "4242",
      });
      await expect(
        dockerNodesRepository.attestRobotSourceAuthority({
          id: CLOUD_RECORD_ID,
          nodeId: "cloud-runtime-1",
          expectedIncarnation: BOOT_C,
          expectedHostKeyFingerprint: "cloud-host-key",
          observedIncarnation: BOOT_C,
          registration: registration(),
        }),
      ).rejects.toThrow(/Cloud registration/);
    },
    PGLITE_TIMEOUT,
  );
});

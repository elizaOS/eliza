import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  spyOn,
  test,
} from "bun:test";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";

process.env.DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
delete process.env.ENVIRONMENT;
setDefaultTimeout(120_000);

import { closeDatabaseConnectionsForTests, getPgliteClientForTests } from "../../db/client";
import { dockerNodesRepository } from "../../db/repositories/docker-nodes";
import { agentSandboxReplacementAttempts } from "../../db/schemas/agent-sandbox-replacement-attempts";
import { agentSandboxes } from "../../db/schemas/agent-sandboxes";
import { containers } from "../../db/schemas/containers";
import { dockerNodes } from "../../db/schemas/docker-nodes";
import { DockerNodeManager } from "./docker-node-manager";
import { DockerSSHClient } from "./docker-ssh";

const FULL_NODE = "placement-full-disk-node";
const ROOMY_NODE = "placement-roomy-node";
const AUTOSCALED_METADATA = JSON.stringify({ provider: "hetzner-cloud", autoscaled: true });

const diskUsedPercentByHost = new Map<string, number>();

async function createTable(table: PgTable): Promise<void> {
  const config = getTableConfig(table);
  const columns = config.columns.map((column) => {
    const type = "enumValues" in column && column.enumValues ? "text" : column.getSQLType();
    return `"${column.name}" ${type}`;
  });
  await getPgliteClientForTests().exec(`CREATE TABLE "${config.name}" (${columns.join(", ")})`);
}

function fakeSshClient(hostname: string): DockerSSHClient {
  return {
    connect: async () => {},
    exec: async (command: string) => {
      if (command.includes("docker info")) return "docker-daemon-id|x86_64";
      if (command.includes("df -P")) {
        const used = diskUsedPercentByHost.get(hostname) ?? 10;
        return [
          "Filesystem     1024-blocks      Used Available Capacity Mounted on",
          `/dev/sda1        100000000  ${used}000000  ${100 - used}000000      ${used}% /`,
        ].join("\n");
      }
      return "";
    },
  } as unknown as DockerSSHClient;
}

beforeAll(async () => {
  await createTable(dockerNodes);
  await createTable(containers);
  await createTable(agentSandboxes);
  await createTable(agentSandboxReplacementAttempts);
  spyOn(DockerSSHClient, "getClient").mockImplementation((hostname: string) =>
    fakeSshClient(hostname),
  );
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

beforeEach(async () => {
  diskUsedPercentByHost.clear();
  await getPgliteClientForTests().exec(`
    TRUNCATE TABLE docker_nodes;
    INSERT INTO docker_nodes
      (id, node_id, hostname, ssh_port, capacity, enabled, placement_state, status,
       allocated_count, ssh_user, metadata, created_at, updated_at)
    VALUES
      (gen_random_uuid(), '${FULL_NODE}', 'full.example.test', 22, 20, true, 'open', 'healthy',
       0, 'root', '${AUTOSCALED_METADATA}'::jsonb, now(), now()),
      (gen_random_uuid(), '${ROOMY_NODE}', 'roomy.example.test', 22, 10, true, 'open', 'healthy',
       0, 'root', '${AUTOSCALED_METADATA}'::jsonb, now(), now());
  `);
});

describe("DockerNodeManager.getAvailableNode", () => {
  test("does not place onto a node degraded for a critically full disk", async () => {
    const manager = new DockerNodeManager();
    diskUsedPercentByHost.set("full.example.test", 97);
    const fullNode = await dockerNodesRepository.findByNodeId(FULL_NODE);

    expect(await manager.healthCheckNode(fullNode!)).toBe("degraded");

    const selected = await manager.getAvailableNode();

    expect(selected?.node_id).toBe(ROOMY_NODE);
    expect((await dockerNodesRepository.findByNodeId(FULL_NODE))?.status).toBe("degraded");
  });
});

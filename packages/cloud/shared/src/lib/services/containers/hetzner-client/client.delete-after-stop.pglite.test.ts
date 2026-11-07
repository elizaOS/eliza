/**
 * A stop removes the Docker container but keeps the row's provider metadata.
 * A later delete (or a second stop) must treat the absent container as already
 * removed, not fail on `docker rm -f`, or the row keeps its quota slot and its
 * volume for ever. Real PGlite rows and repositories; the SSH client is a fake
 * Docker host that tracks whether the container exists.
 */
import { afterAll, beforeAll, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";

process.env.DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
delete process.env.ENVIRONMENT;
setDefaultTimeout(120_000);

import {
  closeDatabaseConnectionsForTests,
  dbWrite,
  getPgliteClientForTests,
} from "../../../../db/client";
import { containersRepository } from "../../../../db/repositories/containers";
import { dockerNodesRepository } from "../../../../db/repositories/docker-nodes";
import { containers } from "../../../../db/schemas/containers";
import { dockerNodes } from "../../../../db/schemas/docker-nodes";
import { organizations } from "../../../../db/schemas/organizations";
import { DockerSSHClient } from "../../docker-ssh";
import { getHetznerContainersClient } from "./client";

const NODE_ID = "delete-after-stop-node";
const HOST = "delete-after-stop.example.test";
const CONTAINER_NAME = "cloud-container-delete-after-stop";
const commands: string[] = [];
let containerPresent = true;

async function createTable(table: PgTable): Promise<void> {
  const config = getTableConfig(table);
  const columns = config.columns.map((column) => {
    const type = "enumValues" in column && column.enumValues ? "text" : column.getSQLType();
    return `"${column.name}" ${type}`;
  });
  await getPgliteClientForTests().exec(`CREATE TABLE "${config.name}" (${columns.join(", ")})`);
}

/** A Docker host: `docker rm -f` of an absent container fails the way dockerd does. */
function fakeDockerHost(): DockerSSHClient {
  return {
    connect: async () => {},
    exec: async (command: string) => {
      commands.push(command);
      if (command.startsWith("docker rm -f")) {
        if (!containerPresent) {
          throw new Error(
            `[docker-ssh] Command exited with code 1 on ${HOST}: [stderr] Error response from daemon: No such container: ${CONTAINER_NAME}`,
          );
        }
        containerPresent = false;
      }
      return "";
    },
  } as unknown as DockerSSHClient;
}

beforeAll(async () => {
  await createTable(dockerNodes);
  await createTable(containers);
  // Delete settles accrued compute against the organization; this fixture has none.
  await createTable(organizations);
  spyOn(DockerSSHClient, "getClient").mockImplementation(() => fakeDockerHost());
  await getPgliteClientForTests().exec(`
    INSERT INTO docker_nodes
      (id, node_id, hostname, ssh_port, capacity, enabled, placement_state, status,
       allocated_count, ssh_user, metadata, created_at, updated_at)
    VALUES
      (gen_random_uuid(), '${NODE_ID}', '${HOST}', 22, 10, true, 'open', 'healthy',
       1, 'root', '{}'::jsonb, now(), now());
  `);
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

test("a stopped container can be stopped again and deleted, and the delete purges its volume", async () => {
  const organizationId = randomUUID();
  const containerId = randomUUID();
  await dbWrite.insert(containers).values({
    id: containerId,
    organization_id: organizationId,
    user_id: randomUUID(),
    name: "api",
    project_name: "acme-api",
    status: "running",
    metadata: {
      provider: "hetzner-docker",
      nodeId: NODE_ID,
      hostname: HOST,
      containerName: CONTAINER_NAME,
      hostPort: 31234,
      image: "ghcr.io/acme/api:1.2.3",
      containerPort: 3000,
      volumePath: `/data/projects/${containerId}`,
    },
  });
  const client = getHetznerContainersClient();

  const stopped = await client.stopContainer(containerId, organizationId, {});
  expect(stopped.status).toBe("stopped");
  expect(containerPresent).toBe(false);
  expect((await dockerNodesRepository.findByNodeId(NODE_ID))?.allocated_count).toBe(0);

  // The container is gone from the host; the row still names it.
  const again = await client.stopContainer(containerId, organizationId, {});
  expect(again.status).toBe("stopped");

  await client.deleteContainer(containerId, organizationId, { purgeVolume: true });
  expect(await containersRepository.findById(containerId, organizationId)).toBeNull();
  expect(commands.filter((c) => c.startsWith("rm -rf"))).toEqual([
    `rm -rf '/data/projects/${containerId}'`,
  ]);
  // The slot was released once, on the first stop.
  expect((await dockerNodesRepository.findByNodeId(NODE_ID))?.allocated_count).toBe(0);
});

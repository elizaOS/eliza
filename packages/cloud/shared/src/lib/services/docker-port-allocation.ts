/**
 * Atomically reserves Docker host ports across managed agents,
 * restore-validation candidates, and app containers. Every allocator writes
 * the same node/port primary-key authority; no caller infers ownership from a
 * pre-read of independently persisted workload rows.
 */

import { and, eq } from "drizzle-orm";
import type { Database, DbTransaction } from "../../db/client";
import { dbWrite } from "../../db/helpers";
import {
  type DockerHostPortKind,
  type DockerHostPortOwnerKind,
  dockerHostPortReservations,
} from "../../db/schemas/docker-host-port-reservations";

export const AGENT_BRIDGE_PORT_MIN = 18790;
export const AGENT_BRIDGE_PORT_MAX = 19790;
export const AGENT_WEB_PORT_MIN = 20000;
export const AGENT_WEB_PORT_MAX = 25000;
export const APP_CONTAINER_HOST_PORT_MIN = 20000;
export const APP_CONTAINER_HOST_PORT_MAX = 40000;

type ReservationDatabase = Pick<Database, "transaction">;

export interface DockerHostPortReservationOwner {
  nodeId: string;
  ownerKind: DockerHostPortOwnerKind;
  ownerId: string;
}

export interface ReservedDockerAgentPorts {
  bridgePort: number;
  webUiPort: number;
}

function assertOwner(owner: DockerHostPortReservationOwner): void {
  if (!owner.nodeId || owner.nodeId.trim() !== owner.nodeId) {
    throw new Error("Docker host-port reservation requires an exact node id");
  }
  if (!owner.ownerId || owner.ownerId.trim() !== owner.ownerId) {
    throw new Error("Docker host-port reservation requires an exact owner id");
  }
}

function kindsForOwner(ownerKind: "agent" | "restore_validation"): {
  bridge: DockerHostPortKind;
  web: DockerHostPortKind;
} {
  return ownerKind === "agent"
    ? { bridge: "agent_bridge", web: "agent_web" }
    : { bridge: "restore_bridge", web: "restore_web" };
}

async function findOwnerReservations(
  tx: DbTransaction,
  owner: DockerHostPortReservationOwner,
): Promise<Array<{ hostPort: number; portKind: DockerHostPortKind }>> {
  return await tx
    .select({
      hostPort: dockerHostPortReservations.host_port,
      portKind: dockerHostPortReservations.port_kind,
    })
    .from(dockerHostPortReservations)
    .where(
      and(
        eq(dockerHostPortReservations.node_id, owner.nodeId),
        eq(dockerHostPortReservations.owner_kind, owner.ownerKind),
        eq(dockerHostPortReservations.owner_id, owner.ownerId),
      ),
    );
}

async function reserveFirstAvailable(
  tx: DbTransaction,
  owner: DockerHostPortReservationOwner,
  portKind: DockerHostPortKind,
  min: number,
  max: number,
): Promise<number> {
  for (let hostPort = min; hostPort < max; hostPort += 1) {
    const [inserted] = await tx
      .insert(dockerHostPortReservations)
      .values({
        node_id: owner.nodeId,
        host_port: hostPort,
        owner_kind: owner.ownerKind,
        owner_id: owner.ownerId,
        port_kind: portKind,
      })
      .onConflictDoNothing()
      .returning({ hostPort: dockerHostPortReservations.host_port });
    if (inserted) return inserted.hostPort;

    const existing = await findOwnerReservations(tx, owner);
    const sameKind = existing.find((row) => row.portKind === portKind);
    if (sameKind) return sameKind.hostPort;
  }
  throw new Error(
    `No atomic Docker host-port reservation available for ${owner.ownerKind}/${portKind} on ${owner.nodeId}`,
  );
}

/**
 * Reserve the bridge/web pair in one transaction. A failure to obtain either
 * port rolls back both ownership rows.
 */
export async function reserveDockerAgentPorts(
  owner: DockerHostPortReservationOwner & { ownerKind: "agent" | "restore_validation" },
  database: ReservationDatabase = dbWrite,
): Promise<ReservedDockerAgentPorts> {
  assertOwner(owner);
  return await database.transaction(async (tx) => {
    return await reserveDockerAgentPortsInTx(owner, tx);
  });
}

/**
 * Reserve a bridge/web pair inside the caller's existing transaction. Restore
 * validation uses this to make physical placement ownership and its durable
 * lifecycle row one indivisible commit before any remote resource can exist.
 */
export async function reserveDockerAgentPortsInTx(
  owner: DockerHostPortReservationOwner & { ownerKind: "agent" | "restore_validation" },
  tx: DbTransaction,
): Promise<ReservedDockerAgentPorts> {
  assertOwner(owner);
  const kinds = kindsForOwner(owner.ownerKind);
  const existing = await findOwnerReservations(tx, owner);
  if (existing.length > 0) {
    const bridge = existing.find((row) => row.portKind === kinds.bridge);
    const web = existing.find((row) => row.portKind === kinds.web);
    if (!bridge || !web || existing.length !== 2) {
      throw new Error(
        `Docker host-port owner ${owner.ownerKind}/${owner.ownerId} has an incomplete reservation pair`,
      );
    }
    return { bridgePort: bridge.hostPort, webUiPort: web.hostPort };
  }

  const bridgePort = await reserveFirstAvailable(
    tx,
    owner,
    kinds.bridge,
    AGENT_BRIDGE_PORT_MIN,
    AGENT_BRIDGE_PORT_MAX,
  );
  const webUiPort = await reserveFirstAvailable(
    tx,
    owner,
    kinds.web,
    AGENT_WEB_PORT_MIN,
    AGENT_WEB_PORT_MAX,
  );
  return { bridgePort, webUiPort };
}

/** Reserve one app host port from the same authority used by agent web ports. */
export async function reserveAppContainerHostPort(
  owner: DockerHostPortReservationOwner & { ownerKind: "app" },
  database: ReservationDatabase = dbWrite,
): Promise<number> {
  assertOwner(owner);
  return await database.transaction(async (tx) => {
    const existing = await findOwnerReservations(tx, owner);
    if (existing.length > 0) {
      if (existing.length !== 1 || existing[0]?.portKind !== "app") {
        throw new Error(`App ${owner.ownerId} has conflicting Docker host-port reservations`);
      }
      return existing[0].hostPort;
    }
    return await reserveFirstAvailable(
      tx,
      owner,
      "app",
      APP_CONTAINER_HOST_PORT_MIN,
      APP_CONTAINER_HOST_PORT_MAX,
    );
  });
}

/**
 * Release only the exact owner's rows on one node. Replays are idempotent; a
 * foreign owner can never be removed by port number.
 */
export async function releaseDockerHostPortReservations(
  owner: DockerHostPortReservationOwner,
  database: ReservationDatabase = dbWrite,
): Promise<number> {
  assertOwner(owner);
  return await database.transaction(async (tx) => {
    const released = await tx
      .delete(dockerHostPortReservations)
      .where(
        and(
          eq(dockerHostPortReservations.node_id, owner.nodeId),
          eq(dockerHostPortReservations.owner_kind, owner.ownerKind),
          eq(dockerHostPortReservations.owner_id, owner.ownerId),
        ),
      )
      .returning({ hostPort: dockerHostPortReservations.host_port });
    return released.length;
  });
}

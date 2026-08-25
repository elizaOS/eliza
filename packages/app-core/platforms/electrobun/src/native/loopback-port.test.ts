/** Exercises findFirstAvailableLoopbackPort against real loopback TCP binds. */
import { type AddressInfo, createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { findFirstAvailableLoopbackPort } from "./loopback-port";

const LOOPBACK = "127.0.0.1";
const held: Server[] = [];

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

function listenOn(host: string, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    const fail = (error: Error) => {
      server.close();
      reject(error);
    };
    server.once("error", fail);
    server.listen({ port, host, exclusive: true }, () => {
      server.off("error", fail);
      resolve(server);
    });
  });
}

async function occupy(host: string, port: number): Promise<Server> {
  const server = await listenOn(host, port);
  held.push(server);
  return server;
}

async function occupyConsecutive(
  host: string,
  count: number,
): Promise<{ start: number; servers: Server[] }> {
  for (let attempt = 0; attempt < 32; attempt++) {
    const probe = await listenOn(host, 0);
    const address = probe.address();
    if (!address || typeof address === "string") {
      await closeServer(probe);
      throw new Error("expected a TCP address from the probe listener");
    }
    const start = address.port;
    await closeServer(probe);
    if (start + count - 1 > 65535) {
      continue;
    }
    const servers: Server[] = [];
    try {
      for (let offset = 0; offset < count; offset++) {
        servers.push(await listenOn(host, start + offset));
      }
      held.push(...servers);
      return { start, servers };
    } catch {
      // error-policy:J3 consecutive occupancy probe collided; try another start
      await Promise.all(servers.map(closeServer));
    }
  }
  throw new Error(`could not occupy ${count} consecutive ports on ${host}`);
}

afterEach(async () => {
  const servers = held.splice(0);
  await Promise.all(servers.map(closeServer));
});

describe("findFirstAvailableLoopbackPort", () => {
  it.each([
    [0],
    [-1],
    [0.9],
    [65536],
    [65535.1],
    [Number.NaN],
    [Number.POSITIVE_INFINITY],
    [Number.NEGATIVE_INFINITY],
  ] as const)("rejects invalid preferred port %s", async (preferred) => {
    await expect(findFirstAvailableLoopbackPort(preferred)).rejects.toThrow(
      `Invalid preferred port: ${preferred}`,
    );
  });

  it("returns the preferred port when it is free", async () => {
    const { start } = await occupyConsecutive(LOOPBACK, 1);
    const [server] = held.splice(0);
    await closeServer(server);

    await expect(
      findFirstAvailableLoopbackPort(start, { host: LOOPBACK, maxHops: 1 }),
    ).resolves.toBe(start);
  });

  it("returns the preferred port when options are omitted", async () => {
    const { start } = await occupyConsecutive(LOOPBACK, 1);
    const [server] = held.splice(0);
    await closeServer(server);

    await expect(findFirstAvailableLoopbackPort(start)).resolves.toBe(start);
  });

  it("skips an occupied preferred port and returns the next hop", async () => {
    const { start } = await occupyConsecutive(LOOPBACK, 1);

    await expect(
      findFirstAvailableLoopbackPort(start, { host: LOOPBACK, maxHops: 4 }),
    ).resolves.toBe(start + 1);
  });

  it("skips a contiguous occupied prefix and returns the first free hop", async () => {
    const { start } = await occupyConsecutive(LOOPBACK, 3);

    await expect(
      findFirstAvailableLoopbackPort(start, { host: LOOPBACK, maxHops: 8 }),
    ).resolves.toBe(start + 3);
  });

  it("uses default maxHops of 64 when options omit it", async () => {
    const { start } = await occupyConsecutive(LOOPBACK, 2);

    await expect(
      findFirstAvailableLoopbackPort(start, { host: LOOPBACK }),
    ).resolves.toBe(start + 2);
  });

  it("throws when every hop in maxHops is occupied", async () => {
    const { start } = await occupyConsecutive(LOOPBACK, 3);

    await expect(
      findFirstAvailableLoopbackPort(start, { host: LOOPBACK, maxHops: 3 }),
    ).rejects.toThrow(
      `No free TCP port on ${LOOPBACK} in range ${start}–${start + 2}`,
    );
  });

  it("throws when maxHops is 0 without probing", async () => {
    await expect(
      findFirstAvailableLoopbackPort(43210, { host: LOOPBACK, maxHops: 0 }),
    ).rejects.toThrow(`No free TCP port on ${LOOPBACK} in range 43210–43209`);
  });

  it("names the default host in the exhaustion error", async () => {
    const { start } = await occupyConsecutive(LOOPBACK, 1);

    await expect(
      findFirstAvailableLoopbackPort(start, { maxHops: 1 }),
    ).rejects.toThrow(
      `No free TCP port on ${LOOPBACK} in range ${start}–${start}`,
    );
  });

  it("honors an explicit host when probing", async () => {
    const { start } = await occupyConsecutive(LOOPBACK, 1);

    await expect(
      findFirstAvailableLoopbackPort(start, { host: LOOPBACK, maxHops: 1 }),
    ).rejects.toThrow(
      `No free TCP port on ${LOOPBACK} in range ${start}–${start}`,
    );
  });

  it("releases a successful probe so the returned port can be bound", async () => {
    const { start } = await occupyConsecutive(LOOPBACK, 1);
    const [server] = held.splice(0);
    await closeServer(server);

    const port = await findFirstAvailableLoopbackPort(start, {
      host: LOOPBACK,
      maxHops: 1,
    });
    expect(port).toBe(start);

    const rebound = await occupy(LOOPBACK, port);
    const address = rebound.address() as AddressInfo;
    expect(address.port).toBe(port);
  });

  it("stops at 65535 instead of wrapping and reports the requested hop window", async () => {
    await occupy(LOOPBACK, 65535);

    await expect(
      findFirstAvailableLoopbackPort(65535, { host: LOOPBACK, maxHops: 4 }),
    ).rejects.toThrow(`No free TCP port on ${LOOPBACK} in range 65535–65538`);
  });

  it("returns 65535 when that port is the preferred free hop", async () => {
    const occupant = await occupy(LOOPBACK, 65535);
    held.splice(held.indexOf(occupant), 1);
    await closeServer(occupant);

    await expect(
      findFirstAvailableLoopbackPort(65535, { host: LOOPBACK, maxHops: 1 }),
    ).resolves.toBe(65535);
  });
});

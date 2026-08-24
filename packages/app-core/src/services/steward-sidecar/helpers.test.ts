/**
 * Unit coverage for Steward Sidecar helpers in helpers.ts.
 *
 * Exercises the real implementations: SHA-256 fingerprinting against
 * published NIST test vectors, tilde expansion through the live process
 * environment, crypto-random key generation shape and uniqueness, sleep
 * wall-clock behaviour, and loopback port allocation against actually
 * bound sockets.
 */

import { createHash } from "node:crypto";
import { createServer, type Server } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  allocateFirstFreeLoopbackPort,
  fingerprintRandomToken,
  generateApiKey,
  generateMasterPassword,
  resolveDataDir,
  sleep,
} from "./helpers.js";

const HEX_64 = /^[0-9a-f]{64}$/;

async function bindLoopback(port: number): Promise<Server> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port, host: "127.0.0.1" }, () => resolve());
  });
  return server;
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

/** Learns a currently-free TCP port by binding port 0 and releasing it. */
async function findFreePort(): Promise<number> {
  const probe = await bindLoopback(0);
  const addr = probe.address();
  if (addr === null || typeof addr === "string") {
    await closeServer(probe);
    throw new Error("expected a TCP listen address");
  }
  await closeServer(probe);
  return addr.port;
}

describe("fingerprintRandomToken", () => {
  it("matches published SHA-256 test vectors", () => {
    // NIST FIPS 180-4 example digests, independent of the implementation.
    expect(fingerprintRandomToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(fingerprintRandomToken("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("returns exactly 64 lowercase hex characters", () => {
    const digest = fingerprintRandomToken("some-high-entropy-token");
    expect(digest).toMatch(HEX_64);
    expect(digest).toBe(
      createHash("sha256").update("some-high-entropy-token").digest("hex"),
    );
  });

  it("produces different digests for different tokens", () => {
    expect(fingerprintRandomToken("token-a")).not.toBe(
      fingerprintRandomToken("token-b"),
    );
  });
});

describe("resolveDataDir", () => {
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }
  });

  it("returns paths without a leading tilde unchanged", () => {
    process.env.HOME = "/Users/someone";
    expect(resolveDataDir("/var/lib/eliza")).toBe("/var/lib/eliza");
    expect(resolveDataDir("relative/dir")).toBe("relative/dir");
  });

  it("leaves tildes that are not in leading position untouched", () => {
    process.env.HOME = "/Users/someone";
    expect(resolveDataDir("/home/user/~notes")).toBe("/home/user/~notes");
  });

  it("expands a bare leading tilde to HOME", () => {
    process.env.HOME = "/Users/someone";
    expect(resolveDataDir("~")).toBe("/Users/someone");
  });

  it("expands a leading tilde prefix inside a path to HOME", () => {
    process.env.HOME = "/Users/someone";
    expect(resolveDataDir("~/eliza/data")).toBe("/Users/someone/eliza/data");
  });

  it("replaces only the leading tilde of the string", () => {
    process.env.HOME = "/Users/someone";
    expect(resolveDataDir("~~/eliza")).toBe("/Users/someone~/eliza");
  });

  it("falls back to USERPROFILE when HOME is unset or empty", () => {
    delete process.env.HOME;
    process.env.USERPROFILE = "/Win/Users/someone";
    expect(resolveDataDir("~/data")).toBe("/Win/Users/someone/data");

    process.env.HOME = "";
    expect(resolveDataDir("~/data")).toBe("/Win/Users/someone/data");
  });

  it("strips the tilde when neither HOME nor USERPROFILE is set", () => {
    delete process.env.HOME;
    delete process.env.USERPROFILE;
    expect(resolveDataDir("~/data")).toBe("/data");
  });
});

describe("generateApiKey", () => {
  it("starts with the stw_ prefix followed by 64 hex characters", () => {
    const key = generateApiKey();
    expect(key.startsWith("stw_")).toBe(true);
    expect(key.slice("stw_".length)).toMatch(HEX_64);
    expect(key).toHaveLength("stw_".length + 64);
  });

  it("generates a distinct key on every call", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 16; i += 1) {
      seen.add(generateApiKey());
    }
    expect(seen.size).toBe(16);
  });
});

describe("generateMasterPassword", () => {
  it("is exactly 64 hex characters with no prefix", () => {
    const password = generateMasterPassword();
    expect(password).toMatch(HEX_64);
    expect(password).toHaveLength(64);
  });

  it("generates a distinct password on every call", () => {
    expect(generateMasterPassword()).not.toBe(generateMasterPassword());
  });
});

describe("sleep", () => {
  it("resolves with undefined after at least the requested delay", async () => {
    const startedAt = Date.now();
    await expect(sleep(25)).resolves.toBeUndefined();
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(25);
  });

  it("resolves immediately for a zero delay", async () => {
    await expect(sleep(0)).resolves.toBeUndefined();
  });
});

describe("allocateFirstFreeLoopbackPort", () => {
  let heldServers: Server[] = [];

  afterEach(async () => {
    const servers = heldServers;
    heldServers = [];
    for (const server of servers) {
      await closeServer(server);
    }
  });

  async function hold(port: number): Promise<void> {
    heldServers.push(await bindLoopback(port));
  }

  it.each([Number.NaN, 0, -5, 65_536, Number.POSITIVE_INFINITY])(
    "rejects invalid preferred port %s",
    async (preferred) => {
      await expect(allocateFirstFreeLoopbackPort(preferred)).rejects.toThrow(
        /Invalid preferred port/,
      );
    },
  );

  it("returns the preferred port itself when it is free", async () => {
    const freePort = await findFreePort();
    await expect(allocateFirstFreeLoopbackPort(freePort)).resolves.toBe(
      freePort,
    );
  });

  it("skips an occupied preferred port and returns the next one", async () => {
    const occupied = await findFreePort();
    await hold(occupied);

    const allocated = await allocateFirstFreeLoopbackPort(occupied);
    expect(allocated).toBe(occupied + 1);

    // The returned port must actually be bindable right now.
    const proof = await bindLoopback(allocated);
    try {
      expect(proof.address()).not.toBeNull();
    } finally {
      await closeServer(proof);
    }
  });

  it("honours an explicit host option while allocating", async () => {
    const freePort = await findFreePort();
    await expect(
      allocateFirstFreeLoopbackPort(freePort, { host: "127.0.0.1" }),
    ).resolves.toBe(freePort);
  });

  it("throws after scanning maxHops consecutive occupied ports", async () => {
    const base = await findFreePort();
    await hold(base);
    await hold(base + 1);

    await expect(
      allocateFirstFreeLoopbackPort(base, { maxHops: 2 }),
    ).rejects.toThrow(
      `No free TCP port on 127.0.0.1 in range ${base}-${base + 1}`,
    );
  });

  it("stops before scanning past port 65535 instead of hopping over the boundary", async () => {
    await hold(65_535);

    await expect(
      allocateFirstFreeLoopbackPort(65_535, { maxHops: 3 }),
    ).rejects.toThrow("No free TCP port on 127.0.0.1 in range 65535-65537");
  });
});

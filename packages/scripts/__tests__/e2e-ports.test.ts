/**
 * Tests the cross-process kernel-port handshake in packages/scripts/e2e-ports.mjs
 * against real files and real child processes — no mocks. Covers the advertise/
 * wait round trip, polling before the file exists, and the three failure paths
 * (child exit, invalid content, timeout) that must never resolve with a
 * fabricated port.
 */

import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { advertisePort, waitForAdvertisedPort } from "../e2e-ports.mjs";

const dir = mkdtempSync(path.join(tmpdir(), "e2e-ports-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("advertisePort / waitForAdvertisedPort", () => {
  it("round-trips the advertised port through the file", async () => {
    const portFile = path.join(dir, "round-trip.port");
    advertisePort(portFile, 43210);
    expect(readFileSync(portFile, "utf8")).toBe("43210\n");
    if (process.platform !== "win32") {
      expect(statSync(portFile).mode & 0o777).toBe(0o600);
    }
    await expect(waitForAdvertisedPort(portFile)).resolves.toBe(43210);
  });

  it("cleans its temporary file when atomic publication fails", () => {
    const portFile = path.join(dir, "blocked.port");
    mkdirSync(portFile);

    expect(() => advertisePort(portFile, 43210)).toThrow();
    expect(
      readdirSync(dir).filter((entry) => entry.startsWith("blocked.port.")),
    ).toEqual([]);
  });

  it("surfaces port-file I/O failures without waiting for timeout", async () => {
    const portFile = path.join(dir, "unreadable.port");
    mkdirSync(portFile);

    await expect(
      waitForAdvertisedPort(portFile, {
        timeoutMs: 10_000,
        pollIntervalMs: 1_000,
      }),
    ).rejects.toThrow(/failed to read/);
  });

  it("polls until a slow child advertises", async () => {
    const portFile = path.join(dir, "slow.port");
    const timer = setTimeout(() => advertisePort(portFile, 50607), 300);
    try {
      await expect(
        waitForAdvertisedPort(portFile, { timeoutMs: 5_000 }),
      ).resolves.toBe(50607);
    } finally {
      clearTimeout(timer);
    }
  });

  it("rejects when the child exits before advertising", async () => {
    const portFile = path.join(dir, "dead-child.port");
    const child = spawn(process.execPath, ["-e", "process.exit(3)"]);
    await new Promise((resolve) => child.once("exit", resolve));
    await expect(
      waitForAdvertisedPort(portFile, { child, timeoutMs: 5_000 }),
    ).rejects.toThrow(/exited with code 3/);
  });

  it("rejects non-port file content instead of fabricating a port", async () => {
    const portFile = path.join(dir, "garbage.port");
    writeFileSync(portFile, "not-a-port\n", "utf8");
    await expect(waitForAdvertisedPort(portFile)).rejects.toThrow(
      /does not contain a port/,
    );
  });

  it("rejects partial numeric content instead of truncating it", async () => {
    const portFile = path.join(dir, "partial.port");
    writeFileSync(portFile, "31338junk\n", "utf8");
    await expect(waitForAdvertisedPort(portFile)).rejects.toThrow(
      /does not contain a port/,
    );
  });

  it("rejects on timeout when nothing advertises", async () => {
    const portFile = path.join(dir, "never.port");
    await expect(
      waitForAdvertisedPort(portFile, { timeoutMs: 300, pollIntervalMs: 50 }),
    ).rejects.toThrow(/timed out/);
  });

  it("refuses to advertise a value that is not a bound TCP port", () => {
    const portFile = path.join(dir, "invalid.port");
    expect(() => advertisePort(portFile, 0)).toThrow(/not a bound TCP port/);
    expect(() => advertisePort(portFile, 70_000)).toThrow(
      /not a bound TCP port/,
    );
  });

  it("hands a real child's kernel-assigned bound port to the orchestrator", async () => {
    const portFile = path.join(dir, "real-child.port");
    const helper = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../e2e-ports.mjs",
    );
    // A real consumer: binds port 0 itself, advertises, stays up briefly.
    const child = spawn(process.execPath, [
      "--input-type=module",
      "-e",
      `import { createServer } from "node:net";
       import { advertisePort } from ${JSON.stringify(`file://${helper}`)};
       const server = createServer();
       server.listen(0, "127.0.0.1", () => {
         advertisePort(${JSON.stringify(portFile)}, server.address().port);
         setTimeout(() => server.close(), 2000);
       });`,
    ]);
    try {
      const port = await waitForAdvertisedPort(portFile, {
        child,
        timeoutMs: 10_000,
      });
      expect(port).toBeGreaterThan(0);
      expect(port).toBeLessThan(65_536);
      // The socket is still held by the child — the port was never released
      // between allocation and consumption (the TOCTOU the review flagged).
      const { createConnection } = await import("node:net");
      await new Promise<void>((resolve, reject) => {
        const probe = createConnection({ host: "127.0.0.1", port }, () => {
          probe.end();
          resolve();
        });
        probe.once("error", reject);
      });
    } finally {
      child.kill();
    }
  });
});

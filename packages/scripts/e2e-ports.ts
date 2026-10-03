/**
 * Kernel-assigned port handshake for multi-process e2e harnesses. Fixed port
 * constants died EADDRINUSE when CI fan-out placed concurrent harness jobs on
 * one shared runner host (#18359), and a probe-then-release allocator is
 * TOCTOU: the probed socket is freed before the consumer binds, so another
 * process can steal the port in between. The race-free contract is therefore
 * that the CONSUMER binds port 0 itself — the kernel hands out a free port at
 * bind time and the socket is never released — and, when the consumer is a
 * child process, it advertises the bound port back to its orchestrator through
 * an atomically renamed port file.
 *
 * In-process servers need no helper: bind port 0 and read the port off the
 * server handle (`Bun.serve({ port: 0 }).port`, `server.address().port`).
 * This module covers the cross-process handshake. Multi-process suites whose
 * workers must independently compute the SAME port without a parent channel
 * keep the per-runner deterministic resolver in
 * packages/homepage/scripts/e2e-port.mjs.
 */

import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

/**
 * Child side: publish the port this process actually bound. The write goes to
 * a temp sibling and is renamed into place so a polling orchestrator can never
 * observe a partially written file.
 *
 * @param {string} portFile destination path agreed with the orchestrator
 * @param {number} port the bound port (from the live server handle)
 */
export function advertisePort(portFile, port) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`advertisePort: not a bound TCP port: ${port}`);
  }
  const tmp = `${portFile}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, `${port}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(tmp, portFile);
  } finally {
    // error-policy:J6 a failed atomic rename must not leave a stale temporary
    // advertisement that can confuse later diagnostics or process runs.
    rmSync(tmp, { force: true });
  }
}

/**
 * Orchestrator side: wait for the child to advertise its bound port. Rejects
 * if the child exits first (pass its ChildProcess as `child`), if the file
 * appears with non-port content, or on timeout — never resolves with a
 * fabricated port.
 *
 * @param {string} portFile path passed to the child
 * @param {{ child?: import("node:child_process").ChildProcess, timeoutMs?: number, pollIntervalMs?: number }} [options]
 * @returns {Promise<number>} the port the child is already bound to
 */
export async function waitForAdvertisedPort(
  portFile,
  { child, timeoutMs = 120_000, pollIntervalMs = 100 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      throw new Error(
        `waitForAdvertisedPort: child exited with ${
          child.exitCode !== null
            ? `code ${child.exitCode}`
            : `signal ${child.signalCode}`
        } before advertising a port (${portFile})`,
      );
    }
    let raw = null;
    try {
      raw = readFileSync(portFile, "utf8");
    } catch (error) {
      // error-policy:J3 only absence is the expected pre-advertisement state;
      // permission, descriptor, and filesystem failures are not equivalent to
      // a child that has not advertised yet.
      if (
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        // error-policy:J2 preserve the underlying filesystem failure while
        // adding the advertisement path the orchestrator needs to diagnose it.
        throw new Error(`waitForAdvertisedPort: failed to read ${portFile}`, {
          cause: error,
        });
      }
    }
    if (raw !== null) {
      const value = raw.trim();
      const port = /^\d+$/.test(value) ? Number.parseInt(value, 10) : NaN;
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new Error(
          `waitForAdvertisedPort: ${portFile} does not contain a port: ${JSON.stringify(raw)}`,
        );
      }
      return port;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `waitForAdvertisedPort: timed out after ${timeoutMs}ms waiting for ${portFile}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

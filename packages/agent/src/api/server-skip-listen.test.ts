import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `skipListen` guard for the local-agent IPC transport (#12180).
 *
 * `startApiServer` cannot be booted inside this vitest lane: `server.ts` imports
 * `@elizaos/app-core` subpaths that the package's test alias rewrites to a
 * non-directory path (ENOTDIR), so its module graph fails to load — this is the
 * same documented constraint that keeps every other agent test from importing
 * `server.ts` (see `health-routes.canRespond-ws.test.ts`). A full boot also
 * needs the built dist + generated i18n data, which is CI-only.
 *
 * So this pins the `skipListen` short-circuit at the source level: it asserts
 * the option exists, is honored BEFORE any `server.listen(...)` call, and
 * returns the same `{ port, close, updateRuntime, updateStartup }` contract as
 * the listening path — i.e. routes/dispatchRoute stay wired, only the TCP bind
 * is skipped. A behavioral end-to-end (`server.listening === false`, no port
 * bound) is exercised by the desktop/mobile IPC capture lanes in CI.
 */

const SERVER_SRC = readFileSync(
  join(import.meta.dirname, "server.ts"),
  "utf8",
);

describe("startApiServer skipListen (#12180)", () => {
  it("declares an optional skipListen boolean on the options object", () => {
    expect(SERVER_SRC).toMatch(/skipListen\?:\s*boolean/);
  });

  it("short-circuits on opts?.skipListen before binding a TCP listener", () => {
    const guardIndex = SERVER_SRC.indexOf("if (opts?.skipListen)");
    expect(guardIndex).toBeGreaterThan(-1);

    // The skip branch must return before the listening Promise is created.
    const listenPromiseIndex = SERVER_SRC.indexOf(
      "return new Promise((resolve, reject) => {",
    );
    expect(listenPromiseIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeLessThan(listenPromiseIndex);

    // Between the guard and the listening Promise there must be no server.listen
    // call — the skip path opens no socket.
    const branchBody = SERVER_SRC.slice(guardIndex, listenPromiseIndex);
    expect(branchBody).not.toMatch(/server\.listen\(/);
  });

  it("returns the full server contract from the skip-listen branch", () => {
    const guardIndex = SERVER_SRC.indexOf("if (opts?.skipListen)");
    const listenPromiseIndex = SERVER_SRC.indexOf(
      "return new Promise((resolve, reject) => {",
    );
    const branchBody = SERVER_SRC.slice(guardIndex, listenPromiseIndex);

    // Same public shape the listening path resolves with, so callers (and the
    // in-process dispatchRoute kernel) are unaffected by the bind being skipped.
    expect(branchBody).toMatch(/return\s*\{/);
    expect(branchBody).toMatch(/\bport\b/);
    expect(branchBody).toMatch(/close:/);
    expect(branchBody).toMatch(/updateRuntime,/);
    expect(branchBody).toMatch(/updateStartup,/);
  });

  it("still runs deferred startup work in skip mode unless explicitly skipped", () => {
    const guardIndex = SERVER_SRC.indexOf("if (opts?.skipListen)");
    const listenPromiseIndex = SERVER_SRC.indexOf(
      "return new Promise((resolve, reject) => {",
    );
    const branchBody = SERVER_SRC.slice(guardIndex, listenPromiseIndex);
    expect(branchBody).toContain("startDeferredStartupWork()");
    expect(branchBody).toContain("skipDeferredStartupWork");
  });

  it("keeps the listening path (default) binding via server.listen", () => {
    // Regression proof for the default path: the un-guarded server.listen call
    // still exists and is reached when skipListen is unset.
    expect(SERVER_SRC).toMatch(/server\.listen\(port,\s*host,/);
  });
});

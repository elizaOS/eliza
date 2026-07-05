import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  allocatePortsForWorktree,
  createEmptyRegistry,
  preferredUiPortForWorktree,
  readRegistry,
  reservePortsForWorktree,
} from "./dev-server-registry.mjs";

describe("shared dev server registry", () => {
  it("allocates stable deterministic ports for a worktree", () => {
    const worktree = "/tmp/eliza-workers/wt-alpha";
    const first = allocatePortsForWorktree(worktree, {
      registry: createEmptyRegistry(),
    }).entry;
    const second = allocatePortsForWorktree(worktree, {
      registry: createEmptyRegistry(),
    }).entry;

    assert.equal(first.uiPort, second.uiPort);
    assert.equal(first.apiPort, first.uiPort + 10_000);
    assert.equal(first.preferredUiPort, preferredUiPortForWorktree(worktree));
  });

  it("keeps two occupied worktrees on distinct ports", () => {
    const alpha = allocatePortsForWorktree("/tmp/eliza-workers/wt-alpha", {
      registry: createEmptyRegistry(),
    });
    alpha.entry.pid = process.pid;
    const beta = allocatePortsForWorktree("/tmp/eliza-workers/wt-beta", {
      registry: alpha.registry,
    });

    assert.notEqual(alpha.entry.uiPort, beta.entry.uiPort);
    assert.notEqual(alpha.entry.apiPort, beta.entry.apiPort);
  });

  it("linear-probes when two worktree hashes prefer the same small range", () => {
    const first = allocatePortsForWorktree("/tmp/a", {
      registry: createEmptyRegistry(),
      base: 2400,
      span: 1,
    });
    first.entry.pid = process.pid;

    assert.throws(
      () =>
        allocatePortsForWorktree("/tmp/b", {
          registry: first.registry,
          base: 2400,
          span: 1,
        }),
      /No free deterministic UI ports/,
    );
  });

  it("writes reservations through the lock-protected registry", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-dev-registry-"));
    const registryPath = path.join(dir, "registry.json");

    const alpha = await reservePortsForWorktree("/tmp/eliza-workers/wt-alpha", {
      registryPath,
    });
    const beta = await reservePortsForWorktree("/tmp/eliza-workers/wt-beta", {
      registryPath,
    });
    const registry = readRegistry(registryPath);

    assert.equal(registry.entries.length, 2);
    assert.notEqual(alpha.uiPort, beta.uiPort);
  });
});

/**
 * Per-session workspace isolation (CRITICAL correctness — audit Wave 0.2).
 *
 * Before this fix, every route-less concurrent task collapsed into ONE shared
 * directory (a configured ELIZA_ACP_WORKSPACE_ROOT / ACPX_DEFAULT_CWD, or the
 * direct-caller DEFAULT_WORKDIR_ROOT), so simultaneous projects corrupted each
 * other's files. The orchestrator now signals `isolate` for shared scratch
 * roots and `spawnSession` lands each session in its own `<root>/task-<id>`
 * subdir — while cwd self-checkout and route/explicit dirs are used verbatim.
 *
 * These are pure assertions on the two seams that make up the guarantee:
 *   1. resolveSpawnWorkdir → does it flag a shared root as `isolate`?
 *   2. computeSessionWorkdir → does it give distinct sessions distinct dirs?
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { computeSessionWorkdir } from "../../src/services/acp-service.js";
import { resolveSpawnWorkdir } from "../../src/services/task-agent-routing.js";

const NO_ROUTE_TASK = "do the unremarkable thing";
const stubRuntime = (settings: Record<string, string>) =>
  ({ getSetting: (key: string) => settings[key] }) as never;

describe("computeSessionWorkdir", () => {
  it("isolates each session into its own subdir of a shared root", () => {
    const base = "/tmp/eliza-acp";
    const a = computeSessionWorkdir(base, "sess-aaaa", true);
    const b = computeSessionWorkdir(base, "sess-bbbb", true);
    expect(a).toBe(path.resolve(base, "task-sess-aaaa"));
    expect(b).toBe(path.resolve(base, "task-sess-bbbb"));
    expect(a).not.toBe(b); // <- the corruption-prevention guarantee
  });

  it("uses the base verbatim when isolation is off (cwd / route / explicit)", () => {
    const base = "/tmp/some-repo";
    expect(computeSessionWorkdir(base, "sess-aaaa", false)).toBe(
      path.resolve(base),
    );
    expect(computeSessionWorkdir(base, "sess-bbbb", false)).toBe(
      path.resolve(base),
    );
  });
});

describe("workspace isolation end-to-end (resolver → per-session dir)", () => {
  it("two route-less concurrent spawns under a configured root get DISTINCT workdirs", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ws-isolation-"));
    const resolved = resolveSpawnWorkdir(
      stubRuntime({ ELIZA_ACP_WORKSPACE_ROOT: root }),
      NO_ROUTE_TASK,
      NO_ROUTE_TASK,
      undefined,
    );
    // resolver flags the shared root for isolation but returns it unchanged…
    expect(resolved).toEqual({ workdir: root, isolate: true });
    // …and spawnSession then forks each session into its own subdir.
    const first = computeSessionWorkdir(
      resolved.workdir,
      "session-1111",
      resolved.isolate === true,
    );
    const second = computeSessionWorkdir(
      resolved.workdir,
      "session-2222",
      resolved.isolate === true,
    );
    expect(first).not.toBe(second);
    expect(first.startsWith(path.resolve(root))).toBe(true);
    expect(second.startsWith(path.resolve(root))).toBe(true);
  });

  it("self-checkout (no configured root) stays in cwd and is NOT isolated", () => {
    const resolved = resolveSpawnWorkdir(
      stubRuntime({}),
      NO_ROUTE_TASK,
      NO_ROUTE_TASK,
      undefined,
    );
    expect(resolved).toEqual({ workdir: process.cwd() });
    // isolate is falsy → both concurrent self-checkout tasks share cwd by design
    // (the agent edits the repo in place). Configure a workspace root for
    // concurrent ad-hoc projects.
    expect(
      computeSessionWorkdir(
        resolved.workdir,
        "session-1111",
        resolved.isolate === true,
      ),
    ).toBe(path.resolve(process.cwd()));
  });
});

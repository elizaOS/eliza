import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSpawnWorkdir } from "../../src/services/task-agent-routing.js";

// `task` / `userRequest` are deliberately chosen so they match no configured
// `TASK_AGENT_WORKDIR_ROUTES` route — these tests exercise the explicit-workdir
// fallback path (steps 3-4), not route resolution.
const NO_ROUTE_TASK = "do the unremarkable thing";

describe("resolveSpawnWorkdir — explicit workdir fallback", () => {
  it("trusts an explicit workdir that exists on disk", () => {
    const existing = os.tmpdir();
    expect(
      resolveSpawnWorkdir(undefined, NO_ROUTE_TASK, NO_ROUTE_TASK, existing),
    ).toEqual({ workdir: existing });
  });

  it("ignores a typo'd explicit workdir that does not exist, falling back to cwd", () => {
    const missing = path.join(
      os.tmpdir(),
      "planner-workdir-typo-does-not-exist",
    );
    const result = resolveSpawnWorkdir(
      undefined,
      NO_ROUTE_TASK,
      NO_ROUTE_TASK,
      missing,
    );
    expect(result).toEqual({ workdir: process.cwd() });
  });

  it("falls back to cwd when no workdir is supplied at all", () => {
    expect(
      resolveSpawnWorkdir(undefined, NO_ROUTE_TASK, NO_ROUTE_TASK, undefined),
    ).toEqual({ workdir: process.cwd() });
  });

  it("ignores a locked workdir that does not exist", () => {
    // `lockWorkdir` is only trusted after a scaffold-aware caller has created
    // the exact target directory. Planner-guessed typo paths must still fall
    // through to route/default resolution.
    const locked = path.join(
      os.tmpdir(),
      "planner-workdir-typo-does-not-exist",
    );
    expect(
      resolveSpawnWorkdir(undefined, NO_ROUTE_TASK, NO_ROUTE_TASK, locked, {
        lockWorkdir: true,
      }),
    ).toEqual({ workdir: process.cwd() });
  });
});

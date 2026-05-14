import * as os from "node:os";
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
    // gpt-oss routinely emits paths like `/home/milody/...` — non-existent and
    // un-creatable (mkdir under `/home` needs root). The guess must be dropped.
    const result = resolveSpawnWorkdir(
      undefined,
      NO_ROUTE_TASK,
      NO_ROUTE_TASK,
      "/home/milody/projects/agent-home",
    );
    expect(result).toEqual({ workdir: process.cwd() });
  });

  it("falls back to cwd when no workdir is supplied at all", () => {
    expect(
      resolveSpawnWorkdir(undefined, NO_ROUTE_TASK, NO_ROUTE_TASK, undefined),
    ).toEqual({ workdir: process.cwd() });
  });

  it("honours lockWorkdir even when the locked path does not exist", () => {
    // `lockWorkdir` is the scaffold-aware opt-out (e.g. APP_CREATE dispatching
    // into a freshly-scaffolded dir the caller is about to create) — it must
    // bypass the existence check.
    const locked = "/home/milody/projects/agent-home";
    expect(
      resolveSpawnWorkdir(undefined, NO_ROUTE_TASK, NO_ROUTE_TASK, locked, {
        lockWorkdir: true,
      }),
    ).toEqual({ workdir: locked });
  });
});

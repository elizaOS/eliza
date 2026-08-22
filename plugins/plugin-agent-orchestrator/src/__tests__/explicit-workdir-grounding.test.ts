/**
 * A planner-supplied existing workdir is honored only when something grounds
 * it: the user named it, it sits inside a route/apps tree, or a known lane
 * uses it. Real temp dirs, no runtime routes.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveSpawnWorkdir } from "../services/task-agent-routing.js";

const root = mkdtempSync(join(tmpdir(), "workdir-grounding-"));
// A configured route lives under `projects/`; its parent is a protected
// location a planner must not invent a build into.
const projects = join(root, "projects");
const routeRepo = join(projects, "agent-home");
const invented = projects;
const laneDir = join(root, "dad-joke-page");
for (const d of [routeRepo, laneDir]) mkdirSync(d, { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));

function runtimeWithSessions(workdirs: string[]) {
  return {
    getSetting: (key: string) =>
      key === "TASK_AGENT_WORKDIR_ROUTES"
        ? JSON.stringify([
            { id: "agent-home", workdir: routeRepo, matchAny: ["agent-home"] },
          ])
        : undefined,
    getService: (name: string) =>
      name === "ACP_SERVICE"
        ? { listSessions: () => workdirs.map((workdir) => ({ workdir })) }
        : undefined,
  } as never;
}

describe("explicit workdir grounding", () => {
  it("ignores a protected directory (a route's parent) the planner invented for a fresh build", () => {
    const r = resolveSpawnWorkdir(
      runtimeWithSessions([]),
      "Write a python script that picks a random card and prints it.",
      "write me a python script that picks a random card",
      invented,
    );
    expect(r.workdir).not.toBe(invented);
  });

  it("honors a protected directory the user named", () => {
    const r = resolveSpawnWorkdir(
      runtimeWithSessions([]),
      `List the repos in ${basename(invented)}`,
      `list the repos in my ${basename(invented)} folder`,
      invented,
    );
    expect(r.workdir).toBe(invented);
  });

  it("still trusts an existing scratch directory (the established contract)", () => {
    const scratch = join(root, "scratch-xyz");
    mkdirSync(scratch, { recursive: true });
    const r = resolveSpawnWorkdir(
      runtimeWithSessions([]),
      "Write a python script that picks a random card.",
      "write me a python script that picks a random card",
      scratch,
    );
    expect(r.workdir).toBe(scratch);
  });

  it("honors a known lane's workdir (continuing finished work)", () => {
    const r = resolveSpawnWorkdir(
      runtimeWithSessions([laneDir]),
      "Add a button that gives a new joke.",
      "add a button that gives me a new joke",
      laneDir,
    );
    expect(r.workdir).toBe(laneDir);
  });
});

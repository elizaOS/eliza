/**
 * A planner-supplied existing workdir is honored only when something grounds
 * it: the user named it, it sits inside a route/apps tree, or a known lane
 * uses it. Real temp dirs, no runtime routes.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveSpawnWorkdir } from "../services/task-agent-routing.js";

const root = mkdtempSync(join(tmpdir(), "workdir-grounding-"));
const invented = join(root, "agent-home");
const laneDir = join(root, "dad-joke-page");
for (const d of [invented, laneDir]) mkdirSync(d, { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));

function runtimeWithSessions(workdirs: string[]) {
  return {
    getSetting: () => undefined,
    getService: (name: string) =>
      name === "ACP_SERVICE"
        ? { listSessions: () => workdirs.map((workdir) => ({ workdir })) }
        : undefined,
  } as never;
}

describe("explicit workdir grounding", () => {
  it("ignores an existing directory the planner invented for a fresh build", () => {
    const r = resolveSpawnWorkdir(
      runtimeWithSessions([]),
      "Write a python script that picks a random card and prints it.",
      "write me a python script that picks a random card",
      invented,
    );
    expect(r.workdir).not.toBe(invented);
  });

  it("honors a directory the user named", () => {
    const r = resolveSpawnWorkdir(
      runtimeWithSessions([]),
      `Fix the readme in ${basename(invented)}`,
      `fix the readme in my ${basename(invented)} folder`,
      invented,
    );
    expect(r.workdir).toBe(invented);
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

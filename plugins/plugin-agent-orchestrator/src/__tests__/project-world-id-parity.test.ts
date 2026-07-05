/**
 * Cross-package guard pinning the orchestrator's project→world derivation to
 * core's single source of truth. `deriveProjectWorldId` (this plugin) must be a
 * pure delegate to `projectWorldId` (`@elizaos/core`) so the two can never drift
 * into the divergence #14171 caught (a second, per-project-only derivation that
 * ignored the per-agent Worlds contract from #13776 D3). Drives both REAL
 * functions — no mock stands in for either derivation.
 */

import { projectWorldId, stringToUuid, type UUID } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { deriveProjectWorldId } from "../services/project-binding.ts";

const AGENTS: readonly UUID[] = [
  "00000000-0000-4000-8000-000000000abc" as UUID,
  "11111111-1111-4111-8111-111111111111" as UUID,
  "deadbeef-0000-4000-8000-00000000cafe" as UUID,
];
const PROJECTS: readonly string[] = ["proj-1", "proj-2", "repo-a", "a/b/c"];

describe("project world id: plugin derivation delegates to core", () => {
  it("deriveProjectWorldId === core projectWorldId for every (agent, project)", () => {
    for (const agentId of AGENTS) {
      for (const projectId of PROJECTS) {
        expect(deriveProjectWorldId(agentId, projectId)).toBe(
          projectWorldId(agentId, projectId),
        );
      }
    }
  });

  it("matches the per-agent createUniqueUuid convention project:<id>:<agentId>", () => {
    const agentId = AGENTS[0];
    expect(deriveProjectWorldId(agentId, "proj-1")).toBe(
      stringToUuid(`project:proj-1:${agentId}`),
    );
  });

  it("is per-agent: the same project yields distinct worlds per agent", () => {
    const a = deriveProjectWorldId(AGENTS[0], "proj-1");
    const b = deriveProjectWorldId(AGENTS[1], "proj-1");
    expect(a).not.toBe(b);
  });

  it("is deterministic and distinct in the project id for a fixed agent", () => {
    const agentId = AGENTS[0];
    const a = deriveProjectWorldId(agentId, "proj-1");
    expect(deriveProjectWorldId(agentId, "proj-1")).toBe(a);
    expect(deriveProjectWorldId(agentId, "proj-2")).not.toBe(a);
  });
});

/**
 * Proves the parent-agent broker is DISCOVERABLE by default sub-agents (#13774):
 * the operating manual advertises the broker to every profile, and the real
 * `spawnAgentForTask` path writes a SKILLS.md for a non-economics spawn with a
 * workdir — not only for economics tasks. Deterministic: real service + store +
 * a capturing ACP over a real temp workdir; no live model, no subprocess.
 */
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeGrillingRuntime } from "../../test/scenarios/_helpers/orchestrator-grilling-harness.ts";
import {
  makeSpawnCapturingAcp,
  reflexionVerifierModel,
  seedReflexionTask,
} from "../../test/scenarios/_helpers/reflexion-scenario.ts";
import { OrchestratorTaskService } from "../services/orchestrator-task-service.js";
import { SUB_AGENT_IDENTITY_MD } from "../services/sub-agent-identity.js";

function makeBaseRuntime(): IAgentRuntime {
  return {
    agentId: "00000000-0000-4000-8000-000000000002",
    character: { name: "Tester" },
    databaseAdapter: undefined,
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    getSetting: () => undefined,
    getService: () => undefined,
    useModel: async () => "{}",
  } as never;
}

/**
 * Drive the real durable-task spawn path with a real temp workdir and return the
 * SKILLS.md content the service wrote (or null if none). `capabilityProfile`
 * selects the fence; `undefined` is the default coding profile.
 */
async function spawnAndReadSkillsManifest(
  capabilityProfile: "economics" | undefined,
): Promise<string | null> {
  const workdir = await realpath(
    await mkdtemp(join(tmpdir(), "subagent-broker-")),
  );
  const savedWorkspaceDir = process.env.ELIZA_WORKSPACE_DIR;
  // resolveAllowedWorkdir only permits the workspace base, cwd, or a configured
  // root — point a configured root at the temp workdir so the spawn is allowed.
  process.env.ELIZA_WORKSPACE_DIR = workdir;
  try {
    const { store, taskId } = await seedReflexionTask(["prove the tests pass"]);
    if (capabilityProfile) {
      await store.updateTask(taskId, { metadata: { capabilityProfile } });
    }
    const acp = makeSpawnCapturingAcp();
    const service = new OrchestratorTaskService(
      makeGrillingRuntime(
        makeBaseRuntime(),
        acp.service,
        reflexionVerifierModel,
      ),
      { store },
    );
    await service.start();
    try {
      await service.spawnAgentForTask(taskId, { workdir });
    } finally {
      await service.stop().catch(() => undefined);
    }
    return await readFile(join(workdir, "SKILLS.md"), "utf8").catch(() => null);
  } finally {
    if (savedWorkspaceDir === undefined) delete process.env.ELIZA_WORKSPACE_DIR;
    else process.env.ELIZA_WORKSPACE_DIR = savedWorkspaceDir;
    await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
  }
}

describe("sub-agent broker discovery (#13774)", () => {
  let savedVerifyFlag: string | undefined;
  beforeEach(() => {
    savedVerifyFlag = process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY;
    delete process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY;
  });
  afterEach(() => {
    if (savedVerifyFlag === undefined)
      delete process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY;
    else process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY = savedVerifyFlag;
  });

  it("advertises the parent-agent broker + Cloud surface in the operating manual for every profile", () => {
    // The manual is profile-independent — it is scaffolded into every bare spawn
    // workspace, so a default (non-economics) coding sub-agent sees the broker.
    expect(SUB_AGENT_IDENTITY_MD).toContain(
      "Asking the parent agent to act (parent-agent broker)",
    );
    expect(SUB_AGENT_IDENTITY_MD).toContain("USE_SKILL parent-agent <json>");
    // The bridge is stated as live for every session, not economics-only.
    expect(SUB_AGENT_IDENTITY_MD).toContain("live for");
    expect(SUB_AGENT_IDENTITY_MD).toContain("EVERY spawned session");
    // The Cloud command surface is enumerated so the manual is self-sufficient.
    expect(SUB_AGENT_IDENTITY_MD).toContain("list-cloud-commands");
    expect(SUB_AGENT_IDENTITY_MD).toContain("cloud-command");
    expect(SUB_AGENT_IDENTITY_MD).toContain("apps.create");
    expect(SUB_AGENT_IDENTITY_MD).toContain("domains.buy");
    // Human-confirmation contract for paid/mutating commands is preserved.
    expect(SUB_AGENT_IDENTITY_MD).toContain("explicit human");
  });

  it("writes a SKILLS.md advertising the broker for a non-economics spawn with a workdir", async () => {
    const manifest = await spawnAndReadSkillsManifest(undefined);
    expect(manifest).not.toBeNull();
    const md = manifest as string;
    expect(md).toContain("Parent Eliza Agent");
    expect(md).toContain("USE_SKILL parent-agent");
    expect(md).toContain("Task-scoped broker skills");
    // The ViewKind contract is economics-only and must NOT leak into the generic
    // (default coding) manifest.
    expect(md).not.toContain("View kind");
  });

  it("economics spawn still gets the ViewKind contract (no regression)", async () => {
    const manifest = await spawnAndReadSkillsManifest("economics");
    expect(manifest).not.toBeNull();
    const md = manifest as string;
    expect(md).toContain("Parent Eliza Agent");
    expect(md).toContain("USE_SKILL parent-agent");
    expect(md).toContain("View kind");
  });
});

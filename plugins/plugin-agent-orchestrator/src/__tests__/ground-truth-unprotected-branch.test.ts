/**
 * The ground-truth gate on a repository whose base branch requires no checks
 * (no branch protection and no rulesets, the GitHub default). GitHub's answers
 * go through the production `getPullRequestGroundTruth` mapping, and
 * validation runs through the production task service on a PGlite-backed
 * AgentRuntime. A failed check must block the gate when the same check still
 * running already does.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntime, IAgentRuntime, ServiceClass } from "@elizaos/core";
import type { GitHubPatClient } from "git-workspace-service";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyGroundTruth } from "../services/ground-truth-verifier.js";
import { OrchestratorTaskService } from "../services/orchestrator-task-service.js";
import { OrchestratorTaskStore } from "../services/orchestrator-task-store.js";
import type { ParsedPullRequestLink } from "../services/pull-request-link.js";
import {
  type GitHubContext,
  type GitHubRequest,
  getPullRequestGroundTruth,
} from "../services/workspace-github.js";
import { CodingWorkspaceService } from "../services/workspace-service.js";
import { createRealTestRuntime } from "./real-runtime.js";

const PR_URL = "https://github.com/acme/widgets/pull/7";

type CheckRun = { name: string; status: string; conclusion: string | null };

/** GitHub for one open PR. Branch protection answers 404 unless `required`
 *  names checks, and the branch has no rulesets. */
function githubFor(checkRuns: CheckRun[], required: string[] = []) {
  return (async (route: string) => {
    if (route.includes("/files")) {
      return { data: [{ filename: "src/widget.ts" }] };
    }
    if (route.includes("/pulls/{pull_number}")) {
      return {
        data: {
          html_url: PR_URL,
          state: "open",
          merged_at: null,
          head: { sha: "abc123" },
          base: { ref: "main" },
        },
      };
    }
    if (route.includes("/check-runs")) {
      return {
        data: {
          check_runs: checkRuns.map((run) => ({ ...run, app: { id: 15368 } })),
        },
      };
    }
    if (route.includes("/status")) return { data: { statuses: [] } };
    if (route.includes("/protection")) {
      if (required.length === 0) {
        throw Object.assign(new Error("Branch not protected"), { status: 404 });
      }
      return { data: { required_status_checks: { contexts: required } } };
    }
    if (route.includes("/rules/branches")) return { data: [] };
    throw new Error(`unexpected route ${route}`);
  }) as GitHubRequest;
}

function githubContext(
  runtime: IAgentRuntime,
  request: GitHubRequest,
): GitHubContext {
  return {
    runtime,
    githubClient: {} as GitHubPatClient,
    setGithubClient: () => {},
    githubRequest: request,
    setGithubRequest: () => {},
    githubAuthInProgress: null,
    setGithubAuthInProgress: () => {},
    authPromptCallback: null,
    log: () => {},
  };
}

const failedTest: CheckRun = {
  name: "ci / test",
  status: "completed",
  conclusion: "failure",
};

const baseDir = mkdtempSync(join(tmpdir(), "ground-truth-unprotected-"));

/** The production workspace service, answering GitHub from `github`. */
class LocalGitHubWorkspaceService extends CodingWorkspaceService {
  github: GitHubRequest = githubFor([]);

  constructor(private readonly host: IAgentRuntime) {
    super(host, { baseDir });
  }

  static override async start(
    runtime: IAgentRuntime,
  ): Promise<CodingWorkspaceService> {
    return new LocalGitHubWorkspaceService(runtime);
  }

  override async getPullRequestGroundTruth(link: ParsedPullRequestLink) {
    return getPullRequestGroundTruth(
      githubContext(this.host, this.github),
      link,
    );
  }
}

let runtime: AgentRuntime;
let cleanupRuntime: (() => Promise<void>) | undefined;
let workspace: LocalGitHubWorkspaceService;

beforeAll(async () => {
  ({ runtime, cleanup: cleanupRuntime } = await createRealTestRuntime({
    characterName: "GroundTruthUnprotectedBranchTest",
    plugins: [
      {
        name: "ground-truth-unprotected-branch-test",
        description: "Registers the workspace service with local GitHub",
        services: [LocalGitHubWorkspaceService as unknown as ServiceClass],
      },
    ],
  }));
  const loaded = await runtime.getServiceLoadPromise(
    CodingWorkspaceService.serviceType,
  );
  if (!(loaded instanceof LocalGitHubWorkspaceService)) {
    throw new Error("Workspace service did not start");
  }
  workspace = loaded;
}, 120_000);

afterAll(async () => {
  await cleanupRuntime?.();
  rmSync(baseDir, { recursive: true, force: true });
});

describe("verifyGroundTruth on an unprotected base branch", () => {
  const input = {
    completion: `Opened ${PR_URL}`,
    claimedFiles: ["src/widget.ts"],
    requirePullRequest: false,
    hardFailEnabled: true,
  };
  const verify = (request: GitHubRequest) =>
    verifyGroundTruth(input, {
      fetchPullRequest: (link) =>
        getPullRequestGroundTruth(githubContext(runtime, request), link),
    });

  it("hard-fails a failed check as it hard-fails a running one", async () => {
    const running = await verify(
      githubFor([
        { name: "ci / test", status: "in_progress", conclusion: null },
      ]),
    );
    expect(running.hardFail).toBe(true);

    const failed = await verify(githubFor([failedTest]));
    expect(failed.checks.state).toBe("red");
    expect(failed.hardFail).toBe(true);
    expect(failed.hardFailReasons.join(" ")).toContain("ci / test");
  });

  it("still ignores a failed optional check when the required checks pass", async () => {
    const verdict = await verify(
      githubFor(
        [
          { name: "build", status: "completed", conclusion: "success" },
          { ...failedTest, name: "lint (optional)" },
        ],
        ["build"],
      ),
    );
    expect(verdict.checks.state).toBe("green");
    expect(verdict.hardFail).toBe(false);
  });
});

describe("validateTask on a PR to an unprotected base branch", () => {
  async function validate(checkRuns: CheckRun[]) {
    workspace.github = githubFor(checkRuns);
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const { task } = await store.createTask({
      title: "Fix the widget",
      goal: "Fix the widget and open a pull request",
      acceptanceCriteria: ["PR open"],
    });
    await store.updateTask(task.id, { status: "active" });
    await store.updateTask(task.id, { status: "validating" });
    const service = new OrchestratorTaskService(runtime, { store });
    const outcome = await service
      .validateTask(task.id, {
        passed: true,
        evidence: `Opened ${PR_URL}`,
        verifier: "operator",
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    return { outcome, status: (await store.getTask(task.id))?.task.status };
  }

  it("validates a PR whose check passed", async () => {
    const { outcome, status } = await validate([
      { name: "ci / test", status: "completed", conclusion: "success" },
    ]);
    expect(outcome).toBeUndefined();
    expect(status).toBe("done");
  });

  it("blocks a PR whose check failed", async () => {
    const { outcome, status } = await validate([failedTest]);
    expect(outcome).toMatchObject({ code: "TASK_GROUND_TRUTH_BLOCKED" });
    expect(status).toBe("validating");
  });
});

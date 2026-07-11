/**
 * Keyless catalog coverage for the plugin-github action and route surface against
 * a mocked GitHub API. Runs on the pr-deterministic lane under the LLM proxy.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type IAgentRuntime, ModelType, type Plugin } from "@elizaos/core";
import type {
  CapturedAction,
  ScenarioContext,
  ScenarioTurnExecution,
} from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import githubPlugin, {
  GitHubService,
} from "../../../../plugins/plugin-github/src/index.ts";
import {
  type RuntimeWithScenarioLlmFixtures,
  registerStrictActionRouteFixtures,
} from "./_helpers/strict-llm-action-fixtures";

const REPO = "octo/repo";
const ISSUE_TITLE = "Deterministic issue";
const ISSUE_BODY = "Created by scenario";
const ISSUE_URL = "https://github.test/octo/repo/issues/17";
const COMMENT_BODY = "Deterministic comment";
const COMMENT_URL = "https://github.test/octo/repo/issues/17#issuecomment-99";
const PR_URL = "https://github.test/octo/repo/pull/17";
const REVIEW_BODY = "Looks good";
const ISSUE_CREATE_PREVIEW =
  'About to create octo/repo issue: "Deterministic issue" [labels: scenario] [assignees: hubot] as agent. Re-invoke with confirmed: true to proceed.';

type JsonRecord = Record<string, unknown>;

type RuntimeWithGithubScenario = IAgentRuntime &
  RuntimeWithScenarioLlmFixtures & {
    getServiceLoadPromise?: (serviceType: string) => Promise<unknown>;
    plugins?: Plugin[];
    registerPlugin?: (plugin: Plugin) => Promise<void>;
    routes?: Array<{
      type?: string;
      path: string;
      handler?: unknown;
      __scenarioGithubRoute?: boolean;
    }>;
  };

type GithubLedgerEntry = {
  method: string;
  args: JsonRecord;
};

let githubLedger: GithubLedgerEntry[] = [];
let originalElizaStateDir: string | undefined;
let scenarioStateDir: string | null = null;
let scenarioRuntime: RuntimeWithGithubScenario | null = null;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

function readPath(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of path.split(".").filter(Boolean)) {
    if (Array.isArray(current) && /^\d+$/.test(segment)) {
      current = current[Number(segment)];
      continue;
    }
    current = isRecord(current) ? current[segment] : undefined;
  }
  return current;
}

function expectEqual(
  actual: unknown,
  expected: unknown,
  label: string,
): string | undefined {
  const actualJson = stableStringify(actual);
  const expectedJson = stableStringify(expected);
  return actualJson === expectedJson
    ? undefined
    : `expected ${label}=${expectedJson}, saw ${actualJson}`;
}

function firstAction(
  execution: ScenarioTurnExecution,
  actionName: string,
): CapturedAction | string {
  const action = execution.actionsCalled.find(
    (candidate) => candidate.actionName === actionName,
  );
  return (
    action ??
    `expected ${actionName} action, saw ${execution.actionsCalled.map((candidate) => candidate.actionName).join(", ") || "none"}`
  );
}

function fakeOctokit() {
  return {
    activity: {
      async listNotificationsForAuthenticatedUser(args: JsonRecord) {
        githubLedger.push({
          method: "activity.listNotificationsForAuthenticatedUser",
          args,
        });
        return {
          data: [
            {
              id: "n-security",
              reason: "security_advisory",
              repository: {
                full_name: REPO,
                pushed_at: new Date().toISOString(),
              },
              subject: {
                title: "Security advisory",
                type: "Issue",
                url: "https://api.github.test/notifications/n-security",
              },
              updated_at: "2026-05-29T12:00:00.000Z",
            },
            {
              id: "n-comment",
              reason: "comment",
              repository: {
                full_name: REPO,
                pushed_at: "2026-05-20T12:00:00.000Z",
              },
              subject: {
                title: "Follow-up comment",
                type: "PullRequest",
                url: "https://api.github.test/notifications/n-comment",
              },
              updated_at: "2026-05-29T11:00:00.000Z",
            },
          ],
        };
      },
    },
    issues: {
      async create(args: JsonRecord) {
        githubLedger.push({ method: "issues.create", args });
        return {
          data: {
            number: 17,
            html_url: ISSUE_URL,
          },
        };
      },
      async addAssignees(args: JsonRecord) {
        githubLedger.push({ method: "issues.addAssignees", args });
        return {
          data: {
            assignees: [{ login: "hubot" }, { login: "octocat" }],
          },
        };
      },
      async update(args: JsonRecord) {
        githubLedger.push({ method: "issues.update", args });
        return {
          data: {
            title: ISSUE_TITLE,
          },
        };
      },
      async createComment(args: JsonRecord) {
        githubLedger.push({ method: "issues.createComment", args });
        return {
          data: {
            id: 99,
            html_url: COMMENT_URL,
          },
        };
      },
      async addLabels(args: JsonRecord) {
        githubLedger.push({ method: "issues.addLabels", args });
        return {
          data: [{ name: "scenario" }, { name: "reviewed" }],
        };
      },
    },
    pulls: {
      async list(args: JsonRecord) {
        githubLedger.push({ method: "pulls.list", args });
        return {
          data: [
            {
              number: 17,
              title: "Deterministic PR",
              user: { login: "hubot" },
              state: "open",
              html_url: PR_URL,
            },
          ],
        };
      },
      async createReview(args: JsonRecord) {
        githubLedger.push({ method: "pulls.createReview", args });
        return {
          data: {
            id: 321,
          },
        };
      },
    },
  };
}

async function ensureGithubPlugin(
  runtime: RuntimeWithGithubScenario,
): Promise<GitHubService> {
  const registered = (runtime.plugins ?? []).some(
    (plugin) => plugin.name === githubPlugin.name,
  );
  if (!registered) {
    await runtime.registerPlugin?.(githubPlugin);
  }
  const routes = runtime.routes ?? [];
  const pluginRoutes = githubPlugin.routes ?? [];
  runtime.routes = routes.filter(
    (route) => route.__scenarioGithubRoute !== true,
  );
  for (const route of pluginRoutes) {
    runtime.routes.push({ ...route, __scenarioGithubRoute: true });
  }
  const service =
    ((await runtime.getServiceLoadPromise?.(GitHubService.serviceType)) as
      | GitHubService
      | undefined) ??
    runtime.getService<GitHubService>(GitHubService.serviceType);
  if (!service) {
    throw new Error("GitHubService was not registered");
  }
  return service;
}

async function seedGithub(ctx: ScenarioContext): Promise<string | undefined> {
  const runtime = ctx.runtime as RuntimeWithGithubScenario | undefined;
  if (!runtime) return "scenario runtime was not available";
  try {
    scenarioRuntime = runtime;
    githubLedger = [];
    originalElizaStateDir = process.env.ELIZA_STATE_DIR;
    scenarioStateDir = mkdtempSync(join(tmpdir(), "eliza-scenario-github-"));
    process.env.ELIZA_STATE_DIR = scenarioStateDir;
    const service = await ensureGithubPlugin(runtime);
    service.setClientForTesting("agent", fakeOctokit() as never);
    service.setClientForTesting("user", fakeOctokit() as never);
    registerGithubStrictFixtures(runtime);
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function githubIssueParameters(confirmed: boolean): Record<string, unknown> {
  return {
    action: "issue_create",
    repo: REPO,
    title: ISSUE_TITLE,
    body: ISSUE_BODY,
    labels: ["scenario"],
    assignees: ["hubot"],
    as: "agent",
    confirmed,
  };
}

function githubActionParameters(
  action: string,
  parameters: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    action,
    repo: REPO,
    as: "agent",
    confirmed: true,
    ...parameters,
  };
}

const strictGithubRoutes = [
  {
    actionName: "GITHUB_ISSUE_CREATE",
    args: githubIssueParameters(false),
    contextIds: ["code"],
    input: "create deterministic GitHub issue preview",
    messageToUser: "Preparing issue preview.",
  },
  {
    actionName: "GITHUB_ISSUE_CREATE",
    args: githubIssueParameters(true),
    contextIds: ["code"],
    input: "yes, create deterministic GitHub issue after confirmation",
    messageToUser: `Created issue ${REPO}#17: ${ISSUE_URL}`,
  },
  {
    actionName: "GITHUB_ISSUE_ASSIGN",
    args: githubActionParameters("issue_assign", {
      number: 17,
      assignees: ["hubot", "octocat"],
    }),
    contextIds: ["code"],
    input: "yes, assign deterministic GitHub issue",
    messageToUser: `Assigned [hubot, octocat] to ${REPO}#17`,
  },
  {
    actionName: "GITHUB_ISSUE_CLOSE",
    args: githubActionParameters("issue_close", { number: 17 }),
    contextIds: ["code"],
    input: "yes, close deterministic GitHub issue",
    messageToUser: `Closed ${REPO}#17: ${ISSUE_TITLE}`,
  },
  {
    actionName: "GITHUB_ISSUE_REOPEN",
    args: githubActionParameters("issue_reopen", { number: 17 }),
    contextIds: ["code"],
    input: "yes, reopen deterministic GitHub issue",
    messageToUser: `Reopened ${REPO}#17: ${ISSUE_TITLE}`,
  },
  {
    actionName: "GITHUB_ISSUE_COMMENT",
    args: githubActionParameters("issue_comment", {
      number: 17,
      body: COMMENT_BODY,
    }),
    contextIds: ["code"],
    input: "yes, comment on deterministic GitHub issue",
    messageToUser: `Commented on ${REPO}#17: ${COMMENT_URL}`,
  },
  {
    actionName: "GITHUB_ISSUE_LABEL",
    args: githubActionParameters("issue_label", {
      number: 17,
      labels: ["scenario", "reviewed"],
    }),
    contextIds: ["code"],
    input: "yes, label deterministic GitHub issue",
    messageToUser: `Applied labels [scenario, reviewed] to ${REPO}#17`,
  },
  {
    actionName: "GITHUB_PR_LIST",
    args: githubActionParameters("pr_list", {
      state: "open",
    }),
    contextIds: ["code"],
    input: "list deterministic GitHub pull requests",
    messageToUser: "Found 1 pull request(s)",
  },
  {
    actionName: "GITHUB",
    args: githubActionParameters("pr_list", {
      state: "open",
    }),
    contextIds: ["code"],
    input: "route deterministic GitHub parent action to pull request list",
    messageToUser: "Found 1 pull request(s)",
  },
  {
    actionName: "GITHUB_PR_REVIEW",
    args: githubActionParameters("pr_review", {
      as: "user",
      number: 17,
      review_action: "approve",
      body: REVIEW_BODY,
    }),
    contextIds: ["code"],
    input: "yes, approve deterministic GitHub pull request",
    messageToUser: `Submitted approve review on ${REPO}#17`,
  },
  {
    actionName: "GITHUB_NOTIFICATION_TRIAGE",
    args: githubActionParameters("notification_triage", {
      as: "user",
    }),
    contextIds: ["code"],
    input: "triage deterministic GitHub notifications",
    messageToUser: "Triaged 2 unread notification(s)",
  },
];

function matchesGithubIssueCreatePreviewEvaluation(value: string): boolean {
  return (
    value.includes(
      "message:user:\ncreate deterministic GitHub issue preview",
    ) &&
    value.includes("event:message_handler:") &&
    value.includes(
      "Stage 1 router marked this current turn as requiring a tool",
    )
  );
}

function registerGithubStrictFixtures(
  runtime: RuntimeWithGithubScenario,
): void {
  registerStrictActionRouteFixtures(runtime, strictGithubRoutes);
  runtime.scenarioLlmFixtures?.register({
    name: "route-github-issue-create-preview-evaluator",
    match: {
      modelType: ModelType.RESPONSE_HANDLER,
      input: matchesGithubIssueCreatePreviewEvaluation,
    },
    response: {
      success: false,
      decision: "FINISH",
      thought: "The issue-create action produced a confirmation preview.",
      messageToUser: ISSUE_CREATE_PREVIEW,
    },
    times: 1,
  });
}

function expectGithubPreview(
  execution: ScenarioTurnExecution,
): string | undefined {
  const action = firstAction(execution, "GITHUB_ISSUE_CREATE");
  if (typeof action === "string") return action;
  if (action.result?.success !== false) {
    return `expected preview result.success=false, saw ${stableStringify(action.result)}`;
  }
  if (readPath(action.result, "raw.requiresConfirmation") !== true) {
    return `expected requiresConfirmation=true, saw ${stableStringify(action.result)}`;
  }
  if (readPath(action.result, "raw.preview") !== ISSUE_CREATE_PREVIEW) {
    return `expected preview text ${JSON.stringify(ISSUE_CREATE_PREVIEW)}, saw ${JSON.stringify(readPath(action.result, "raw.preview"))}`;
  }
  // The action delivers the confirmation prompt (preview + the "reply yes"
  // follow-up) as the single user-facing bubble; the planner's shorter echo of
  // the bare preview is a redundant prefix and is suppressed by the runtime.
  const previewResponse = `${ISSUE_CREATE_PREVIEW} Reply yes to confirm or no to cancel.`;
  if (execution.responseText !== previewResponse) {
    return `expected responseText preview, saw ${JSON.stringify(execution.responseText)}`;
  }
  if (githubLedger.length !== 0) {
    return `preview should not call Octokit, saw ${stableStringify(githubLedger)}`;
  }
  return undefined;
}

function expectGithubCreate(
  execution: ScenarioTurnExecution,
): string | undefined {
  const action = firstAction(execution, "GITHUB_ISSUE_CREATE");
  if (typeof action === "string") return action;
  if (action.result?.success !== true) {
    return `expected create result.success=true, saw ${stableStringify(action.result)}`;
  }
  for (const [path, expected] of Object.entries({
    "data.op": "create",
    "data.number": 17,
    "data.url": ISSUE_URL,
  })) {
    const failure = expectEqual(readPath(action.result, path), expected, path);
    if (failure) return failure;
  }
  // The action reply carries the issue URL; the planner's URL-stripped echo is a
  // redundant prefix the runtime suppresses, so the URL-bearing reply is what the
  // user sees.
  const responseText = `Created issue ${REPO}#17: ${ISSUE_URL}`;
  if (execution.responseText !== responseText) {
    return `expected create response ${JSON.stringify(responseText)}, saw ${JSON.stringify(execution.responseText)}`;
  }
  const expectedLedger = [
    {
      method: "issues.create",
      args: {
        owner: "octo",
        repo: "repo",
        title: ISSUE_TITLE,
        body: ISSUE_BODY,
        labels: ["scenario"],
        assignees: ["hubot"],
      },
    },
  ];
  return expectEqual(githubLedger, expectedLedger, "GitHub Octokit ledger");
}

function expectGithubIssueAssign(
  execution: ScenarioTurnExecution,
): string | undefined {
  const action = firstAction(execution, "GITHUB_ISSUE_ASSIGN");
  if (typeof action === "string") return action;
  if (action.result?.success !== true) {
    return `expected assign result.success=true, saw ${stableStringify(action.result)}`;
  }
  for (const [path, expected] of Object.entries({
    "data.op": "assign",
    "data.number": 17,
    "data.assignees.0": "hubot",
    "data.assignees.1": "octocat",
  })) {
    const failure = expectEqual(readPath(action.result, path), expected, path);
    if (failure) return failure;
  }
  const responseText = `Assigned [hubot, octocat] to ${REPO}#17`;
  return execution.responseText === responseText
    ? undefined
    : `expected assign response ${JSON.stringify(responseText)}, saw ${JSON.stringify(execution.responseText)}`;
}

function expectGithubIssueState(
  actionName: "GITHUB_ISSUE_CLOSE" | "GITHUB_ISSUE_REOPEN",
  op: "close" | "reopen",
  responseText: string,
): (execution: ScenarioTurnExecution) => string | undefined {
  return (execution) => {
    const action = firstAction(execution, actionName);
    if (typeof action === "string") return action;
    if (action.result?.success !== true) {
      return `expected ${op} result.success=true, saw ${stableStringify(action.result)}`;
    }
    for (const [path, expected] of Object.entries({
      "data.op": op,
      "data.number": 17,
      "data.title": ISSUE_TITLE,
    })) {
      const failure = expectEqual(
        readPath(action.result, path),
        expected,
        path,
      );
      if (failure) return failure;
    }
    return execution.responseText === responseText
      ? undefined
      : `expected ${op} response ${JSON.stringify(responseText)}, saw ${JSON.stringify(execution.responseText)}`;
  };
}

function expectGithubIssueComment(
  execution: ScenarioTurnExecution,
): string | undefined {
  const action = firstAction(execution, "GITHUB_ISSUE_COMMENT");
  if (typeof action === "string") return action;
  if (action.result?.success !== true) {
    return `expected comment result.success=true, saw ${stableStringify(action.result)}`;
  }
  for (const [path, expected] of Object.entries({
    "data.op": "comment",
    "data.number": 17,
    "data.commentId": 99,
    "data.url": COMMENT_URL,
  })) {
    const failure = expectEqual(readPath(action.result, path), expected, path);
    if (failure) return failure;
  }
  // As with create, the action reply carries the comment URL and the planner's
  // URL-stripped echo is suppressed as a redundant prefix.
  const responseText = `Commented on ${REPO}#17: ${COMMENT_URL}`;
  return execution.responseText === responseText
    ? undefined
    : `expected comment response ${JSON.stringify(responseText)}, saw ${JSON.stringify(execution.responseText)}`;
}

function expectGithubIssueLabel(
  execution: ScenarioTurnExecution,
): string | undefined {
  const action = firstAction(execution, "GITHUB_ISSUE_LABEL");
  if (typeof action === "string") return action;
  if (action.result?.success !== true) {
    return `expected label result.success=true, saw ${stableStringify(action.result)}`;
  }
  for (const [path, expected] of Object.entries({
    "data.op": "label",
    "data.number": 17,
    "data.labels.0": "scenario",
    "data.labels.1": "reviewed",
  })) {
    const failure = expectEqual(readPath(action.result, path), expected, path);
    if (failure) return failure;
  }
  const responseText = `Applied labels [scenario, reviewed] to ${REPO}#17`;
  return execution.responseText === responseText
    ? undefined
    : `expected label response ${JSON.stringify(responseText)}, saw ${JSON.stringify(execution.responseText)}`;
}

function expectGithubPrList(
  execution: ScenarioTurnExecution,
): string | undefined {
  const action = firstAction(execution, "GITHUB_PR_LIST");
  if (typeof action === "string") return action;
  if (action.result?.success !== true) {
    return `expected pr list result.success=true, saw ${stableStringify(action.result)}`;
  }
  for (const [path, expected] of Object.entries({
    "data.op": "list",
    "data.prs.0.repo": REPO,
    "data.prs.0.number": 17,
    "data.prs.0.title": "Deterministic PR",
    "data.prs.0.author": "hubot",
    "data.prs.0.state": "open",
    "data.prs.0.url": PR_URL,
  })) {
    const failure = expectEqual(readPath(action.result, path), expected, path);
    if (failure) return failure;
  }
  return execution.responseText === "Found 1 pull request(s)"
    ? undefined
    : `expected PR list response, saw ${JSON.stringify(execution.responseText)}`;
}

function expectGithubParentPrList(
  execution: ScenarioTurnExecution,
): string | undefined {
  const action = firstAction(execution, "GITHUB");
  if (typeof action === "string") return action;
  if (action.result?.success !== true) {
    return `expected parent GitHub result.success=true, saw ${stableStringify(action.result)}`;
  }
  for (const [path, expected] of Object.entries({
    "data.op": "list",
    "data.prs.0.repo": REPO,
    "data.prs.0.number": 17,
    "data.prs.0.title": "Deterministic PR",
  })) {
    const failure = expectEqual(readPath(action.result, path), expected, path);
    if (failure) return failure;
  }
  return execution.responseText === "Found 1 pull request(s)"
    ? undefined
    : `expected parent GitHub response, saw ${JSON.stringify(execution.responseText)}`;
}

function expectGithubPrReview(
  execution: ScenarioTurnExecution,
): string | undefined {
  const action = firstAction(execution, "GITHUB_PR_REVIEW");
  if (typeof action === "string") return action;
  if (action.result?.success !== true) {
    return `expected pr review result.success=true, saw ${stableStringify(action.result)}`;
  }
  for (const [path, expected] of Object.entries({
    "data.op": "review",
    "data.id": 321,
  })) {
    const failure = expectEqual(readPath(action.result, path), expected, path);
    if (failure) return failure;
  }
  const responseText = `Submitted approve review on ${REPO}#17`;
  return execution.responseText === responseText
    ? undefined
    : `expected PR review response ${JSON.stringify(responseText)}, saw ${JSON.stringify(execution.responseText)}`;
}

function expectGithubNotificationTriage(
  execution: ScenarioTurnExecution,
): string | undefined {
  const action = firstAction(execution, "GITHUB_NOTIFICATION_TRIAGE");
  if (typeof action === "string") return action;
  if (action.result?.success !== true) {
    return `expected notification triage result.success=true, saw ${stableStringify(action.result)}`;
  }
  for (const [path, expected] of Object.entries({
    "data.totalUnread": 2,
    "data.notificationLimit": 25,
    "data.notifications.0.id": "n-security",
    "data.notifications.0.reason": "security_advisory",
    "data.notifications.1.id": "n-comment",
    "data.notifications.1.reason": "comment",
  })) {
    const failure = expectEqual(readPath(action.result, path), expected, path);
    if (failure) return failure;
  }
  return execution.responseText === "Triaged 2 unread notification(s)"
    ? undefined
    : `expected notification triage response, saw ${JSON.stringify(execution.responseText)}`;
}

function expectGithubTokenRoute(
  status: number,
  body: unknown,
): string | undefined {
  if (status !== 200) return `expected status 200, saw ${status}`;
  return expectEqual(
    body,
    { connected: false, deviceFlowAvailable: false },
    "GitHub token route body",
  );
}

async function finalGithubCheck(): Promise<string | undefined> {
  const service = scenarioRuntime?.getService<GitHubService>(
    GitHubService.serviceType,
  );
  service?.setClientForTesting("agent", null);
  service?.setClientForTesting("user", null);
  const expectedLedger = [
    {
      method: "issues.create",
      args: {
        owner: "octo",
        repo: "repo",
        title: ISSUE_TITLE,
        body: ISSUE_BODY,
        labels: ["scenario"],
        assignees: ["hubot"],
      },
    },
    {
      method: "issues.addAssignees",
      args: {
        owner: "octo",
        repo: "repo",
        issue_number: 17,
        assignees: ["hubot", "octocat"],
      },
    },
    {
      method: "issues.update",
      args: {
        owner: "octo",
        repo: "repo",
        issue_number: 17,
        state: "closed",
      },
    },
    {
      method: "issues.update",
      args: {
        owner: "octo",
        repo: "repo",
        issue_number: 17,
        state: "open",
      },
    },
    {
      method: "issues.createComment",
      args: {
        owner: "octo",
        repo: "repo",
        issue_number: 17,
        body: COMMENT_BODY,
      },
    },
    {
      method: "issues.addLabels",
      args: {
        owner: "octo",
        repo: "repo",
        issue_number: 17,
        labels: ["scenario", "reviewed"],
      },
    },
    {
      method: "pulls.list",
      args: {
        owner: "octo",
        repo: "repo",
        state: "open",
        per_page: 100,
      },
    },
    {
      method: "pulls.list",
      args: {
        owner: "octo",
        repo: "repo",
        state: "open",
        per_page: 100,
      },
    },
    {
      method: "pulls.createReview",
      args: {
        owner: "octo",
        repo: "repo",
        pull_number: 17,
        event: "APPROVE",
        body: REVIEW_BODY,
      },
    },
    {
      method: "activity.listNotificationsForAuthenticatedUser",
      args: {
        all: false,
        per_page: 50,
      },
    },
  ];
  const ledgerFailure = expectEqual(
    githubLedger,
    expectedLedger,
    "GitHub Octokit ledger",
  );
  if (originalElizaStateDir === undefined) {
    delete process.env.ELIZA_STATE_DIR;
  } else {
    process.env.ELIZA_STATE_DIR = originalElizaStateDir;
  }
  if (scenarioStateDir) {
    rmSync(scenarioStateDir, { recursive: true, force: true });
    scenarioStateDir = null;
  }
  return ledgerFailure;
}

export default scenario({
  id: "deterministic-github-actions-routes",
  lane: "pr-deterministic",
  title: "Deterministic GitHub action and route coverage",
  domain: "scenario-runner",
  tags: ["pr", "deterministic", "zero-cost", "github", "routes"],
  isolation: "shared-runtime",
  requires: {
    plugins: ["@elizaos/plugin-github"],
  },
  seed: [
    {
      type: "custom",
      name: "register real GitHub plugin with fake Octokit client and isolated state dir",
      apply: seedGithub,
    },
  ],
  rooms: [
    {
      id: "main",
      source: "github",
      title: "Deterministic GitHub Actions",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "GitHub issue create requires explicit confirmation",
      text: "create deterministic GitHub issue preview",
      assertTurn: expectGithubPreview,
    },
    {
      kind: "message",
      name: "GitHub issue create calls fake Octokit after confirmation",
      text: "yes, create deterministic GitHub issue after confirmation",
      assertTurn: expectGithubCreate,
    },
    {
      kind: "action",
      name: "GitHub issue assign asks for confirmation",
      actionName: "GITHUB_ISSUE_ASSIGN",
      text: "assign deterministic GitHub issue",
      options: {
        parameters: githubActionParameters("issue_assign", {
          number: 17,
          assignees: ["hubot", "octocat"],
        }),
      },
    },
    {
      kind: "message",
      name: "GitHub issue assign calls fake Octokit",
      text: "yes, assign deterministic GitHub issue",
      assertTurn: expectGithubIssueAssign,
    },
    {
      kind: "action",
      name: "GitHub issue close asks for confirmation",
      actionName: "GITHUB_ISSUE_CLOSE",
      text: "close deterministic GitHub issue",
      options: {
        parameters: githubActionParameters("issue_close", { number: 17 }),
      },
    },
    {
      kind: "message",
      name: "GitHub issue close calls fake Octokit",
      text: "yes, close deterministic GitHub issue",
      assertTurn: expectGithubIssueState(
        "GITHUB_ISSUE_CLOSE",
        "close",
        `Closed ${REPO}#17: ${ISSUE_TITLE}`,
      ),
    },
    {
      kind: "action",
      name: "GitHub issue reopen asks for confirmation",
      actionName: "GITHUB_ISSUE_REOPEN",
      text: "reopen deterministic GitHub issue",
      options: {
        parameters: githubActionParameters("issue_reopen", { number: 17 }),
      },
    },
    {
      kind: "message",
      name: "GitHub issue reopen calls fake Octokit",
      text: "yes, reopen deterministic GitHub issue",
      assertTurn: expectGithubIssueState(
        "GITHUB_ISSUE_REOPEN",
        "reopen",
        `Reopened ${REPO}#17: ${ISSUE_TITLE}`,
      ),
    },
    {
      kind: "action",
      name: "GitHub issue comment asks for confirmation",
      actionName: "GITHUB_ISSUE_COMMENT",
      text: "comment on deterministic GitHub issue",
      options: {
        parameters: githubActionParameters("issue_comment", {
          number: 17,
          body: COMMENT_BODY,
        }),
      },
    },
    {
      kind: "message",
      name: "GitHub issue comment calls fake Octokit",
      text: "yes, comment on deterministic GitHub issue",
      assertTurn: expectGithubIssueComment,
    },
    {
      kind: "action",
      name: "GitHub issue label asks for confirmation",
      actionName: "GITHUB_ISSUE_LABEL",
      text: "label deterministic GitHub issue",
      options: {
        parameters: githubActionParameters("issue_label", {
          number: 17,
          labels: ["scenario", "reviewed"],
        }),
      },
    },
    {
      kind: "message",
      name: "GitHub issue label calls fake Octokit",
      text: "yes, label deterministic GitHub issue",
      assertTurn: expectGithubIssueLabel,
    },
    {
      kind: "message",
      name: "GitHub pull request list calls fake Octokit",
      text: "list deterministic GitHub pull requests",
      assertTurn: expectGithubPrList,
    },
    {
      kind: "message",
      name: "GitHub parent action routes to PR list",
      text: "route deterministic GitHub parent action to pull request list",
      assertTurn: expectGithubParentPrList,
    },
    {
      kind: "action",
      name: "GitHub pull request review asks for confirmation",
      actionName: "GITHUB_PR_REVIEW",
      text: "approve deterministic GitHub pull request",
      options: {
        parameters: githubActionParameters("pr_review", {
          as: "user",
          number: 17,
          review_action: "approve",
          body: REVIEW_BODY,
        }),
      },
    },
    {
      kind: "message",
      name: "GitHub pull request review calls fake Octokit",
      text: "yes, approve deterministic GitHub pull request",
      assertTurn: expectGithubPrReview,
    },
    {
      kind: "message",
      name: "GitHub notification triage calls fake Octokit",
      text: "triage deterministic GitHub notifications",
      assertTurn: expectGithubNotificationTriage,
    },
    {
      kind: "api",
      name: "GitHub token route reads isolated empty state",
      method: "GET",
      path: "/api/github/token",
      expectedStatus: 200,
      assertResponse: expectGithubTokenRoute,
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "GITHUB_ISSUE_CREATE",
      minCount: 2,
    },
    {
      type: "actionCalled",
      actionName: "GITHUB_ISSUE_ASSIGN",
      status: "success",
      minCount: 1,
    },
    {
      type: "actionCalled",
      actionName: "GITHUB_ISSUE_CLOSE",
      status: "success",
      minCount: 1,
    },
    {
      type: "actionCalled",
      actionName: "GITHUB_ISSUE_REOPEN",
      status: "success",
      minCount: 1,
    },
    {
      type: "actionCalled",
      actionName: "GITHUB_ISSUE_COMMENT",
      status: "success",
      minCount: 1,
    },
    {
      type: "actionCalled",
      actionName: "GITHUB_ISSUE_LABEL",
      status: "success",
      minCount: 1,
    },
    {
      type: "actionCalled",
      actionName: "GITHUB_PR_LIST",
      status: "success",
      minCount: 1,
    },
    {
      type: "actionCalled",
      actionName: "GITHUB",
      status: "success",
      minCount: 1,
    },
    {
      type: "actionCalled",
      actionName: "GITHUB_PR_REVIEW",
      status: "success",
      minCount: 1,
    },
    {
      type: "actionCalled",
      actionName: "GITHUB_NOTIFICATION_TRIAGE",
      status: "success",
      minCount: 1,
    },
    {
      type: "custom",
      name: "GitHub fake Octokit ledger is exact and isolated state is restored",
      predicate: finalGithubCheck,
    },
  ],
});

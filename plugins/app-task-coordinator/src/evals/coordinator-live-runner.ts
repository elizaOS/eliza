import { execFile } from "node:child_process";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  CoordinatorEvalClient,
  resolveCoordinatorEvalBaseUrl,
} from "./coordinator-eval-client.js";
import {
  type CoordinatorPreflightResult,
  runCoordinatorPreflight,
} from "./coordinator-preflight.js";
import {
  type CoordinatorEvalChannel,
  type CoordinatorScenario,
  listCoordinatorScenarios,
} from "./coordinator-scenarios.js";

const execFileAsync = promisify(execFile);
const URL_RE = /\bhttps?:\/\/\S+/i;
const ABSOLUTE_PATH_RE =
  /(?:^|\s)(\/[A-Za-z0-9._\-~/]+(?:\/[A-Za-z0-9._\-~]+)+)/;
const DEFAULT_SCENARIO_TIMEOUT_MS = 180_000;
const TURN_SETTLE_MS = 1_500;

type TrajectoryListItem = {
  id: string;
  source?: string;
  status?: string;
  scenarioId?: string;
  batchId?: string;
  metadata?: Record<string, unknown>;
};

type TaskThreadSummary = {
  id: string;
  title: string;
  status: string;
  latestWorkdir?: string | null;
};

type TaskThreadDetail = TaskThreadSummary & {
  scenarioId?: string | null;
  batchId?: string | null;
  sessions?: Array<{
    id: string;
    sessionId: string;
    workdir: string;
    status: string;
  }>;
  artifacts?: Array<{
    id: string;
    artifactType: string;
    title: string;
    path?: string | null;
    uri?: string | null;
  }>;
  events?: Array<{ eventType: string; summary: string }>;
  transcripts?: Array<{ direction: string; content: string }>;
};

type TaskShareDiscovery = {
  threadId: string;
  shareCapabilities?: string[];
  preferredTarget?: {
    type: string;
    value: string;
    remoteAccessible?: boolean;
  } | null;
  targets?: Array<{
    type: string;
    value: string;
    remoteAccessible?: boolean;
  }>;
};

export interface CoordinatorScenarioRunCheck {
  id: string;
  passed: boolean;
  details?: Record<string, unknown>;
}

export interface CoordinatorScenarioRunResult {
  batchId: string;
  scenarioId: string;
  channel: CoordinatorEvalChannel;
  conversationId: string;
  outputDir: string;
  responses: Array<{
    turn: number;
    prompt: string;
    responseText: string;
  }>;
  trajectoryIds: string[];
  threadIds: string[];
  checks: CoordinatorScenarioRunCheck[];
  passed: boolean;
}

export interface RunCoordinatorLiveScenariosOptions {
  baseUrl?: string;
  batchId?: string;
  profile?: "smoke" | "core" | "full";
  channels?: CoordinatorEvalChannel[];
  scenarioIds?: string[];
  outputRoot?: string;
  scenarioTimeoutMs?: number;
}

type EvaluatedPreflightIssue = {
  id: string;
  summary: string;
  details?: Record<string, unknown>;
};

type SkippedChannel = {
  channel: CoordinatorEvalChannel;
  reason: string;
};

function generateBatchId(): string {
  return `coordinator-eval-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

function defaultOutputRoot(): string {
  return path.join(process.cwd(), ".tmp", "coordinator-evals");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function perTurnTimeoutMs(totalTimeoutMs: number): number {
  return Math.max(1_000, Math.floor(totalTimeoutMs / 2));
}

function channelMessageSource(
  channel: CoordinatorEvalChannel,
): string | undefined {
  return channel === "app_chat" ? "client_chat" : channel;
}

function allCoordinatorChannels(
  preflight: CoordinatorPreflightResult,
): CoordinatorEvalChannel[] {
  const channels: CoordinatorEvalChannel[] = [
    "app_chat",
    ...preflight.supportedConnectors,
  ];
  return uniqueChannels(channels);
}

function getCheck(preflight: CoordinatorPreflightResult, id: string) {
  return preflight.checks.find((check) => check.id === id);
}

function uniqueChannels(
  channels: CoordinatorEvalChannel[],
): CoordinatorEvalChannel[] {
  return channels.filter(
    (channel, index) => channels.indexOf(channel) === index,
  );
}

function scenarioNeedsTaskThread(scenario: CoordinatorScenario): boolean {
  return scenario.requiredCapabilities.some((capability) =>
    [
      "create_task",
      "repo_tasking",
      "task_execution",
      "pause_task",
      "resume_task",
      "stop_task",
      "archive_task",
      "reopen_task",
      "multi_agent_coordination",
      "live_provider_execution",
    ].includes(capability),
  );
}

function scenarioNeedsArtifacts(scenario: CoordinatorScenario): boolean {
  return scenario.requiredCapabilities.some((capability) =>
    [
      "artifact_visibility",
      "preview_visibility",
      "artifact_lookup",
      "artifact_reporting",
      "share_discovery",
      "report_generation",
      "bundle_export",
      "worktree_artifacts",
    ].includes(capability),
  );
}

function scenarioNeedsChangedFiles(scenario: CoordinatorScenario): boolean {
  return scenario.requiredCapabilities.some((capability) =>
    [
      "create_task",
      "iterative_editing",
      "repo_tasking",
      "worktree_artifacts",
      "multi_agent_coordination",
    ].includes(capability),
  );
}

function scenarioNeedsSingleThread(scenario: CoordinatorScenario): boolean {
  return scenario.requiredCapabilities.some((capability) =>
    ["continue_task", "resume_task"].includes(capability),
  );
}

function responseLooksShareable(text: string): boolean {
  return URL_RE.test(text) || ABSOLUTE_PATH_RE.test(text);
}

function trajectoryGrouping(trajectory: TrajectoryListItem): {
  scenarioId?: string;
  batchId?: string;
} {
  const metadata =
    trajectory.metadata && typeof trajectory.metadata === "object"
      ? trajectory.metadata
      : {};
  return {
    scenarioId:
      trajectory.scenarioId ??
      (typeof metadata.scenarioId === "string"
        ? metadata.scenarioId
        : undefined),
    batchId:
      trajectory.batchId ??
      (typeof metadata.batchId === "string" ? metadata.batchId : undefined),
  };
}

async function listFilesRecursively(
  root: string,
  limit = 200,
): Promise<string[]> {
  const files: string[] = [];
  const queue = [root];
  while (queue.length > 0 && files.length < limit) {
    const current = queue.shift();
    if (!current) continue;
    try {
      const entries = await readdir(current, {
        withFileTypes: true,
        encoding: "utf8",
      });
      for (const entry of entries) {
        if (files.length >= limit) break;
        const nextPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === ".git" || entry.name === "node_modules") continue;
          queue.push(nextPath);
        } else if (entry.isFile()) {
          files.push(nextPath);
        }
      }
    } catch {}
  }
  return files;
}

async function collectChangedFilesForWorkdir(workdir: string): Promise<{
  workdir: string;
  git: boolean;
  files: string[];
}> {
  try {
    const result = await execFileAsync(
      "git",
      ["-C", workdir, "status", "--short"],
      {
        timeout: 10_000,
      },
    );
    const files = result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.replace(/^[A-Z? ]+\s+/, ""))
      .filter(Boolean);
    return { workdir, git: true, files };
  } catch {
    return {
      workdir,
      git: false,
      files: await listFilesRecursively(workdir, 100),
    };
  }
}

async function waitForEvidence<T>(
  loader: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs: number,
  intervalMs = 2_000,
): Promise<T> {
  const startedAt = Date.now();
  let lastValue = await loader();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate(lastValue)) {
      return lastValue;
    }
    await delay(intervalMs);
    lastValue = await loader();
  }
  return lastValue;
}

async function ensureTrajectoryLoggingEnabled(
  client: CoordinatorEvalClient,
): Promise<void> {
  const config = await client.requestJson<{ enabled?: boolean }>(
    "/api/trajectories/config",
  );
  if (config.enabled === true) return;
  await client.requestJson("/api/trajectories/config", {
    method: "PUT",
    body: { enabled: true },
  });
}

function evaluatePreflight(params: {
  preflight: CoordinatorPreflightResult;
  requestedChannels: CoordinatorEvalChannel[];
  selectedScenarios: CoordinatorScenario[];
}): {
  requestedChannels: CoordinatorEvalChannel[];
  usableChannels: CoordinatorEvalChannel[];
  skippedChannels: SkippedChannel[];
  runnableFrameworks: string[];
  hardBlockers: EvaluatedPreflightIssue[];
  recordedFailures: EvaluatedPreflightIssue[];
  warnings: EvaluatedPreflightIssue[];
} {
  const { preflight, requestedChannels, selectedScenarios } = params;
  const usableChannels = requestedChannels.filter((channel) =>
    preflight.availableChannels.includes(channel),
  );
  const skippedChannels = requestedChannels
    .filter((channel) => !preflight.availableChannels.includes(channel))
    .map((channel) => ({
      channel,
      reason: `Channel ${channel} is not configured or not currently available in Eliza.`,
    }));

  const runnableFrameworks = ["codex", "claude"].filter(
    (frameworkId) =>
      getCheck(preflight, `framework-${frameworkId}`)?.status === "pass",
  );
  const hardBlockers: EvaluatedPreflightIssue[] = [];

  const apiCheck = getCheck(preflight, "eliza-api");
  if (apiCheck?.status === "fail") {
    hardBlockers.push({
      id: apiCheck.id,
      summary: apiCheck.summary,
      ...(apiCheck.details ? { details: apiCheck.details } : {}),
    });
  }

  if (usableChannels.length === 0) {
    hardBlockers.push({
      id: "usable-channels",
      summary:
        "None of the requested channels are available for this live batch.",
      details: {
        requestedChannels,
        availableChannels: preflight.availableChannels,
      },
    });
  }

  if (
    selectedScenarios.some((scenario) => scenarioNeedsTaskThread(scenario)) &&
    runnableFrameworks.length === 0
  ) {
    hardBlockers.push({
      id: "task-frameworks",
      summary:
        "No runnable coordinator task-execution framework is available for scenarios that require live task work.",
      details: {
        frameworkChecks: preflight.checks.filter((check) =>
          check.id.startsWith("framework-"),
        ),
      },
    });
  }

  const recordedFailures = preflight.checks
    .filter((check) => check.status === "fail")
    .filter((check) => !hardBlockers.some((blocker) => blocker.id === check.id))
    .map((check) => ({
      id: check.id,
      summary: check.summary,
      ...(check.details ? { details: check.details } : {}),
    }));
  const warnings = preflight.checks
    .filter((check) => check.status === "warn")
    .map((check) => ({
      id: check.id,
      summary: check.summary,
      ...(check.details ? { details: check.details } : {}),
    }));

  return {
    requestedChannels,
    usableChannels,
    skippedChannels,
    runnableFrameworks,
    hardBlockers,
    recordedFailures,
    warnings,
  };
}

function scenarioOutputDir(
  outputRoot: string,
  batchId: string,
  scenarioId: string,
  channel: CoordinatorEvalChannel,
): string {
  return path.join(outputRoot, batchId, `${scenarioId}-${channel}`);
}

async function gatherScenarioEvidence(params: {
  client: CoordinatorEvalClient;
  scenario: CoordinatorScenario;
  channel: CoordinatorEvalChannel;
  batchId: string;
  conversationId: string;
  outputDir: string;
  timeoutMs: number;
}): Promise<CoordinatorScenarioRunResult> {
  const {
    client,
    scenario,
    channel,
    batchId,
    conversationId,
    outputDir,
    timeoutMs,
  } = params;
  await mkdir(outputDir, { recursive: true });

  const trajectoriesResult = await waitForEvidence(
    () =>
      client.requestJson<{
        trajectories?: TrajectoryListItem[];
      }>(
        `/api/trajectories?limit=200&scenarioId=${encodeURIComponent(scenario.id)}&batchId=${encodeURIComponent(batchId)}`,
      ),
    (value) =>
      Array.isArray(value.trajectories) && value.trajectories.length > 0,
    Math.max(30_000, Math.floor(timeoutMs / 2)),
  );
  const trajectories = Array.isArray(trajectoriesResult.trajectories)
    ? trajectoriesResult.trajectories
    : [];

  const loadThreads = () =>
    client.requestJson<TaskThreadSummary[]>(
      `/api/coding-agents/coordinator/threads?includeArchived=true&scenarioId=${encodeURIComponent(scenario.id)}&batchId=${encodeURIComponent(batchId)}&limit=50`,
    );
  const threads = scenarioNeedsTaskThread(scenario)
    ? await waitForEvidence(
        loadThreads,
        (value) => Array.isArray(value) && value.length > 0,
        Math.max(30_000, Math.floor(timeoutMs / 2)),
      )
    : await loadThreads();
  const threadCountResponse = await waitForEvidence(
    () =>
      client.requestJson<{ total: number }>(
        `/api/coding-agents/coordinator/threads/count?includeArchived=true&scenarioId=${encodeURIComponent(scenario.id)}&batchId=${encodeURIComponent(batchId)}`,
      ),
    (value) =>
      !scenarioNeedsTaskThread(scenario) ||
      (typeof value.total === "number" && value.total > 0),
    Math.max(30_000, Math.floor(timeoutMs / 2)),
  );
  const threadDetails: TaskThreadDetail[] = [];
  for (const thread of threads) {
    const detail = await client.requestJson<TaskThreadDetail>(
      `/api/coding-agents/coordinator/threads/${encodeURIComponent(thread.id)}`,
    );
    threadDetails.push(detail);
  }
  const shareDetails: TaskShareDiscovery[] = [];
  if (scenarioNeedsArtifacts(scenario)) {
    for (const thread of threadDetails) {
      try {
        const share = await client.requestJson<TaskShareDiscovery>(
          `/api/coding-agents/coordinator/threads/${encodeURIComponent(thread.id)}/share`,
        );
        shareDetails.push(share);
      } catch {
        shareDetails.push({
          threadId: thread.id,
          shareCapabilities: [],
          preferredTarget: null,
          targets: [],
        });
      }
    }
  }

  const messages = await client.listConversationMessages(conversationId);
  const trajectoryZip = await client.requestBuffer("/api/trajectories/export", {
    method: "POST",
    body: {
      format: "zip",
      includePrompts: true,
      scenarioId: scenario.id,
      batchId,
    },
  });
  await writeFile(path.join(outputDir, "trajectory-export.zip"), trajectoryZip);

  const changedFiles = [];
  for (const thread of threadDetails) {
    for (const session of thread.sessions ?? []) {
      try {
        const info = await stat(session.workdir);
        if (!info.isDirectory()) continue;
        changedFiles.push(await collectChangedFilesForWorkdir(session.workdir));
      } catch {
        changedFiles.push({
          workdir: session.workdir,
          git: false,
          files: [],
        });
      }
    }
  }

  const allArtifacts = threadDetails.flatMap(
    (thread) => thread.artifacts ?? [],
  );
  const transcriptCount = threadDetails.reduce(
    (sum, thread) => sum + (thread.transcripts?.length ?? 0),
    0,
  );
  const responseText = messages
    .map((message) =>
      typeof message.text === "string"
        ? message.text
        : typeof message.content?.text === "string"
          ? message.content.text
          : "",
    )
    .join("\n");

  const checks: CoordinatorScenarioRunCheck[] = [
    {
      id: "trajectory-logged",
      passed: trajectories.length > 0,
      details: { count: trajectories.length },
    },
    {
      id: "trajectory-batch-filter",
      passed: trajectories.every((trajectory) => {
        const grouping = trajectoryGrouping(trajectory);
        return (
          grouping.scenarioId === scenario.id && grouping.batchId === batchId
        );
      }),
      details: {
        sources: trajectories.map(
          (trajectory) => trajectory.source ?? "unknown",
        ),
      },
    },
    {
      id: "connector-source",
      passed:
        channel === "app_chat"
          ? true
          : trajectories.some((trajectory) => trajectory.source === channel),
      details: { channel },
    },
    {
      id: "db-count-match",
      passed: (threadCountResponse.total ?? 0) === threadDetails.length,
      details: {
        countRoute: threadCountResponse.total ?? 0,
        listCount: threadDetails.length,
      },
    },
    {
      id: "thread-batch-filter",
      passed: threadDetails.every(
        (thread) =>
          thread.scenarioId === scenario.id && thread.batchId === batchId,
      ),
      details: {
        threadIds: threadDetails.map((thread) => thread.id),
      },
    },
  ];

  if (scenarioNeedsTaskThread(scenario)) {
    checks.push({
      id: "task-thread-created",
      passed: threadDetails.length > 0,
      details: { count: threadDetails.length },
    });
  }

  if (scenarioNeedsSingleThread(scenario) && threadDetails.length > 0) {
    checks.push({
      id: "thread-reuse",
      passed: new Set(threadDetails.map((thread) => thread.id)).size === 1,
      details: { threadIds: threadDetails.map((thread) => thread.id) },
    });
  }

  if (scenarioNeedsArtifacts(scenario)) {
    checks.push({
      id: "artifacts-or-shareable-response",
      passed:
        allArtifacts.length > 0 ||
        shareDetails.some((detail) => (detail.targets?.length ?? 0) > 0) ||
        responseLooksShareable(responseText),
      details: {
        artifactCount: allArtifacts.length,
        shareTargets: shareDetails.reduce(
          (sum, detail) => sum + (detail.targets?.length ?? 0),
          0,
        ),
        responsePreview: responseText.slice(0, 300),
      },
    });
  }

  if (scenarioNeedsTaskThread(scenario)) {
    checks.push({
      id: "transcript-captured",
      passed: transcriptCount > 0,
      details: { transcriptCount },
    });
  }

  if (scenarioNeedsChangedFiles(scenario)) {
    const changedFileCount = changedFiles.reduce(
      (sum, item) => sum + item.files.length,
      0,
    );
    checks.push({
      id: "changed-files",
      passed: changedFileCount > 0,
      details: { changedFileCount },
    });
  }

  await client.writeJson(path.join(outputDir, "conversation.json"), messages);
  await client.writeJson(path.join(outputDir, "threads.json"), threadDetails);
  await client.writeJson(path.join(outputDir, "artifacts.json"), allArtifacts);
  await client.writeJson(path.join(outputDir, "shares.json"), shareDetails);
  await client.writeJson(
    path.join(outputDir, "changed-files.json"),
    changedFiles,
  );
  await client.writeJson(
    path.join(outputDir, "trajectories.json"),
    trajectories,
  );
  await client.writeJson(path.join(outputDir, "db-assertions.json"), {
    scenarioId: scenario.id,
    batchId,
    threadCountRoute: threadCountResponse.total ?? 0,
    threadCountList: threadDetails.length,
    trajectoryCount: trajectories.length,
    transcriptCount,
    groupedThreads: threadDetails.every(
      (thread) =>
        thread.scenarioId === scenario.id && thread.batchId === batchId,
    ),
    groupedTrajectories: trajectories.every((trajectory) => {
      const grouping = trajectoryGrouping(trajectory);
      return (
        grouping.scenarioId === scenario.id && grouping.batchId === batchId
      );
    }),
  });
  await client.writeJson(path.join(outputDir, "checks.json"), checks);

  return {
    batchId,
    scenarioId: scenario.id,
    channel,
    conversationId,
    outputDir,
    responses: [],
    trajectoryIds: trajectories.map((trajectory) => trajectory.id),
    threadIds: threadDetails.map((thread) => thread.id),
    checks,
    passed: checks.every((check) => check.passed),
  };
}

export async function runCoordinatorLiveScenarios(
  options: RunCoordinatorLiveScenariosOptions = {},
): Promise<{
  batchId: string;
  baseUrl: string;
  outputRoot: string;
  preflight: CoordinatorPreflightResult;
  requestedChannels: CoordinatorEvalChannel[];
  usableChannels: CoordinatorEvalChannel[];
  skippedChannels: SkippedChannel[];
  runnableFrameworks: string[];
  preflightHardBlockers: EvaluatedPreflightIssue[];
  preflightFailures: EvaluatedPreflightIssue[];
  preflightWarnings: EvaluatedPreflightIssue[];
  runs: CoordinatorScenarioRunResult[];
}> {
  const baseUrl = resolveCoordinatorEvalBaseUrl(options.baseUrl);
  const outputRoot = options.outputRoot?.trim() || defaultOutputRoot();
  const batchId = options.batchId?.trim() || generateBatchId();
  const client = new CoordinatorEvalClient(baseUrl);
  const preflight = await runCoordinatorPreflight({ baseUrl });
  const selectedScenarios = listCoordinatorScenarios(
    options.profile ?? "full",
  ).filter((scenario) =>
    options.scenarioIds?.length
      ? options.scenarioIds.includes(scenario.id)
      : true,
  );
  if (selectedScenarios.length === 0) {
    throw new Error("No coordinator scenarios matched the requested filters.");
  }

  const requestedChannels = uniqueChannels(
    options.channels && options.channels.length > 0
      ? options.channels
      : allCoordinatorChannels(preflight),
  );
  const scenarioTimeoutMs =
    options.scenarioTimeoutMs ?? DEFAULT_SCENARIO_TIMEOUT_MS;
  const turnTimeoutMs = perTurnTimeoutMs(scenarioTimeoutMs);
  const runs: CoordinatorScenarioRunResult[] = [];
  await mkdir(path.join(outputRoot, batchId), { recursive: true });
  await client.writeJson(
    path.join(outputRoot, batchId, "preflight.json"),
    preflight,
  );
  const preflightEvaluation = evaluatePreflight({
    preflight,
    requestedChannels,
    selectedScenarios,
  });
  await client.writeJson(
    path.join(outputRoot, batchId, "preflight-evaluation.json"),
    {
      ...preflightEvaluation,
      selectedScenarioIds: selectedScenarios.map((scenario) => scenario.id),
    },
  );
  if (preflightEvaluation.hardBlockers.length > 0) {
    throw new Error(
      `Coordinator eval preflight failed: ${preflightEvaluation.hardBlockers
        .map((blocker) => `${blocker.id}: ${blocker.summary}`)
        .join("; ")}`,
    );
  }

  await ensureTrajectoryLoggingEnabled(client);

  for (const scenario of selectedScenarios) {
    for (const channel of preflightEvaluation.usableChannels) {
      if (!scenario.channels.includes(channel)) continue;

      let conversation: Awaited<
        ReturnType<CoordinatorEvalClient["createConversation"]>
      >;
      try {
        conversation = await client.createConversation(
          `[eval:${batchId}] ${scenario.id} ${channel} ${scenario.title}`,
          turnTimeoutMs,
        );
      } catch (error) {
        throw new Error(
          `Scenario ${scenario.id} could not create a conversation on ${channel}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      const outputDir = scenarioOutputDir(
        outputRoot,
        batchId,
        scenario.id,
        channel,
      );
      const responses: Array<{
        turn: number;
        prompt: string;
        responseText: string;
      }> = [];

      for (const [index, turn] of scenario.turns.entries()) {
        let response: Awaited<
          ReturnType<CoordinatorEvalClient["postConversationMessage"]>
        >;
        try {
          response = await client.postConversationMessage({
            conversationId: conversation.id,
            text: turn.text,
            source: channelMessageSource(channel),
            channelType: "DM",
            timeoutMs: turnTimeoutMs,
            metadata: {
              scenarioId: scenario.id,
              batchId,
              eval: {
                scenarioId: scenario.id,
                batchId,
                channel,
              },
              connectorName: channel === "app_chat" ? null : channel,
            },
          });
        } catch (error) {
          throw new Error(
            `Scenario ${scenario.id} turn ${index + 1} on ${channel} failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        responses.push({
          turn: index + 1,
          prompt: turn.text,
          responseText: response.text,
        });
        await delay(TURN_SETTLE_MS);
      }

      const evidence = await gatherScenarioEvidence({
        client,
        scenario,
        channel,
        batchId,
        conversationId: conversation.id,
        outputDir,
        timeoutMs: scenarioTimeoutMs,
      });
      evidence.responses = responses;

      await client.writeJson(path.join(outputDir, "scenario.json"), scenario);
      await client.writeJson(path.join(outputDir, "responses.json"), responses);
      await client.writeJson(path.join(outputDir, "verdict.json"), {
        passed: evidence.passed,
        checks: evidence.checks,
      });

      runs.push(evidence);
    }
  }

  await client.writeJson(path.join(outputRoot, batchId, "manifest.json"), {
    batchId,
    baseUrl,
    outputRoot,
    requestedChannels: preflightEvaluation.requestedChannels,
    usableChannels: preflightEvaluation.usableChannels,
    skippedChannels: preflightEvaluation.skippedChannels,
    runnableFrameworks: preflightEvaluation.runnableFrameworks,
    preflightHardBlockers: preflightEvaluation.hardBlockers,
    preflightFailures: preflightEvaluation.recordedFailures,
    preflightWarnings: preflightEvaluation.warnings,
    runs,
  });

  return {
    batchId,
    baseUrl,
    outputRoot,
    preflight,
    requestedChannels: preflightEvaluation.requestedChannels,
    usableChannels: preflightEvaluation.usableChannels,
    skippedChannels: preflightEvaluation.skippedChannels,
    runnableFrameworks: preflightEvaluation.runnableFrameworks,
    preflightHardBlockers: preflightEvaluation.hardBlockers,
    preflightFailures: preflightEvaluation.recordedFailures,
    preflightWarnings: preflightEvaluation.warnings,
    runs,
  };
}

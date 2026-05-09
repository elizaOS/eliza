import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

import { type IAgentRuntime, ModelType } from "@elizaos/core";
import { parseJsonObjectResponse } from "./json-model-output.js";
import type {
  SwarmCoordinatorContext,
  TaskContext,
} from "./swarm-coordinator.js";
import type { TaskThreadDetail } from "./task-registry.js";
import { withTrajectoryContext } from "./trajectory-context.js";

type ValidationVerdict = "pass" | "revise" | "escalate";

interface TrajectoryListItem {
  id: string;
  status: string;
  llmCallCount: number;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

interface ValidationResponse {
  verdict: ValidationVerdict;
  summary: string;
  followUpPrompt?: string;
  checklist?: string[];
}

export interface TaskValidationResult {
  verdict: ValidationVerdict;
  summary: string;
  followUpPrompt?: string;
  reportPath: string;
  artifacts: Array<{
    artifactType: string;
    title: string;
    path?: string | null;
    uri?: string | null;
    mimeType?: string | null;
    metadata?: Record<string, unknown>;
  }>;
}

export interface ValidateTaskCompletionInput {
  sessionId: string;
  taskCtx: TaskContext;
  completionReasoning: string;
  completionSummary: string;
  turnOutput: string;
}

type TrajectoryLoggerLike = {
  listTrajectories?: (options?: {
    limit?: number;
    offset?: number;
    search?: string;
    startDate?: string;
  }) => Promise<{ trajectories?: TrajectoryListItem[] } | null | undefined>;
};

type ScreenshotSemanticResult = {
  contentVerified: boolean;
  contentSummary?: string;
  contentVerificationError?: string;
};

function normalizeValidationResponse(
  parsed: unknown,
): ValidationResponse | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const verdict = record.verdict;
  const summary =
    typeof record.summary === "string" ? record.summary.trim() : "";
  if (
    (verdict !== "pass" && verdict !== "revise" && verdict !== "escalate") ||
    !summary
  ) {
    return null;
  }
  const followUpPrompt =
    typeof record.followUpPrompt === "string"
      ? record.followUpPrompt.trim()
      : "";
  const checklist = Array.isArray(record.checklist)
    ? record.checklist.filter(
        (item): item is string =>
          typeof item === "string" && item.trim().length > 0,
      )
    : undefined;
  return {
    verdict,
    summary,
    ...(followUpPrompt ? { followUpPrompt } : {}),
    ...(checklist && checklist.length > 0 ? { checklist } : {}),
  };
}

function parseValidationResponse(raw: string): ValidationResponse | null {
  return normalizeValidationResponse(parseJsonObjectResponse(raw));
}

function getValidationRootDir(): string {
  const stateDir =
    process.env.ELIZA_STATE_DIR?.trim() || path.join(homedir(), ".eliza");
  return path.join(stateDir, "task-validation");
}

function truncate(text: string, limit = 1200): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= limit) return compact;
  return `${compact.slice(0, limit)}...`;
}

function pngHeaderValid(buffer: Uint8Array): boolean {
  if (buffer.length < 8) return false;
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  return signature.every((value, index) => buffer[index] === value);
}

type ValidationScreenshotCapture =
  | {
      status: "captured";
      path: string;
      sizeBytes: number;
      fileIntegrityVerified: boolean;
      sha256: string;
      captureScope: "desktop-fullscreen";
      contentVerified: boolean;
      contentSummary?: string;
      contentVerificationError?: string;
    }
  | {
      status: "unavailable";
      reason: string;
    };

function resolveLoopbackApiBase(): string {
  const port =
    process.env.ELIZA_API_PORT?.trim() ||
    process.env.ELIZA_PORT?.trim() ||
    "31337";
  return `http://127.0.0.1:${port}`;
}

async function captureValidationScreenshot(
  runtime: IAgentRuntime,
  task: TaskContext,
  thread: TaskThreadDetail | null,
  sessionId: string,
): Promise<ValidationScreenshotCapture> {
  try {
    const token =
      process.env.ELIZA_API_TOKEN?.trim() ||
      process.env.ELIZA_API_AUTH_TOKEN?.trim();
    const response = await fetch(
      `${resolveLoopbackApiBase()}/api/dev/cursor-screenshot`,
      {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      },
    );
    if (!response.ok) {
      return {
        status: "unavailable",
        reason: `HTTP ${response.status} from /api/dev/cursor-screenshot`,
      };
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length === 0) {
      return {
        status: "unavailable",
        reason: "Screenshot endpoint returned an empty PNG payload",
      };
    }

    const dir = path.join(getValidationRootDir(), task.threadId);
    await mkdir(dir, { recursive: true });
    const screenshotPath = path.join(
      dir,
      `screenshot-${sessionId}-${Date.now()}.png`,
    );
    await writeFile(screenshotPath, bytes);

    const screenshotDescription = await describeScreenshotContent(
      runtime,
      task,
      thread,
      bytes,
    );

    return {
      status: "captured",
      path: screenshotPath,
      sizeBytes: bytes.length,
      fileIntegrityVerified: pngHeaderValid(bytes) && bytes.length > 1024,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      captureScope: "desktop-fullscreen",
      contentVerified: screenshotDescription.contentVerified,
      ...(screenshotDescription.contentSummary
        ? { contentSummary: screenshotDescription.contentSummary }
        : {}),
      ...(screenshotDescription.contentVerificationError
        ? {
            contentVerificationError:
              screenshotDescription.contentVerificationError,
          }
        : {}),
    };
  } catch (error) {
    return {
      status: "unavailable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function listRelevantTrajectories(
  runtime: IAgentRuntime,
  task: TaskContext,
  thread: TaskThreadDetail | null,
): Promise<TrajectoryListItem[]> {
  const logger = runtime.getService("trajectories") as
    | TrajectoryLoggerLike
    | null
    | undefined;
  if (!logger?.listTrajectories) {
    return [];
  }

  const searchTerms = [
    task.sessionId,
    task.threadId,
    task.label,
    task.originalTask,
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));

  const seen = new Set<string>();
  const trajectories: TrajectoryListItem[] = [];
  for (const search of searchTerms) {
    const result = await logger.listTrajectories({
      limit: 10,
      search,
      ...(thread?.createdAt ? { startDate: thread.createdAt } : {}),
    });
    for (const item of result?.trajectories ?? []) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      const metadata = (item.metadata ?? {}) as Record<string, unknown>;
      const orchestrator = metadata.orchestrator as
        | Record<string, unknown>
        | undefined;
      const sessionMatches =
        orchestrator?.sessionId === task.sessionId ||
        metadata.sessionId === task.sessionId;
      const labelMatches =
        orchestrator?.taskLabel === task.label ||
        metadata.taskLabel === task.label;
      if (!sessionMatches && !labelMatches && search !== task.sessionId) {
        continue;
      }
      trajectories.push(item);
      if (trajectories.length >= 3) {
        return trajectories;
      }
    }
  }

  return trajectories;
}

function extractImageDescriptionText(raw: unknown): string | null {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (raw && typeof raw === "object") {
    const description = (raw as { description?: unknown }).description;
    if (typeof description === "string" && description.trim().length > 0) {
      return description.trim();
    }
  }
  return null;
}

async function describeScreenshotContent(
  runtime: IAgentRuntime,
  task: TaskContext,
  thread: TaskThreadDetail | null,
  bytes: Uint8Array,
): Promise<ScreenshotSemanticResult> {
  try {
    const dataUri = `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
    const acceptanceCriteria = thread?.acceptanceCriteria?.length
      ? thread.acceptanceCriteria.map((item) => `- ${item}`).join("\n")
      : "- none";
    const raw = await runtime.useModel(ModelType.IMAGE_DESCRIPTION, {
      imageUrl: dataUri,
      prompt: [
        "Describe this validation screenshot for an orchestrated task.",
        "Focus on visible terminal output, UI state, status banners, tests, errors, and other completion evidence.",
        `Task: ${task.originalTask}`,
        "Acceptance criteria:",
        acceptanceCriteria,
        "Return a concise factual description.",
      ].join("\n"),
    });
    const contentSummary = extractImageDescriptionText(raw);
    if (!contentSummary) {
      return {
        contentVerified: false,
        contentVerificationError:
          "Vision model returned no usable screenshot description.",
      };
    }
    return {
      contentVerified: true,
      contentSummary: truncate(contentSummary, 800),
    };
  } catch (error) {
    return {
      contentVerified: false,
      contentVerificationError:
        error instanceof Error ? error.message : String(error),
    };
  }
}

function describeScreenshotEvidence(
  screenshot: ValidationScreenshotCapture,
): string {
  if (screenshot.status !== "captured") {
    return `- status=unavailable reason=${screenshot.reason}`;
  }
  return `- status=captured scope=${screenshot.captureScope} fileIntegrityVerified=${screenshot.fileIntegrityVerified} contentVerified=${screenshot.contentVerified} sha256=${screenshot.sha256} path=${screenshot.path} sizeBytes=${screenshot.sizeBytes}${screenshot.contentSummary ? ` summary=${truncate(screenshot.contentSummary, 500)}` : ""}${screenshot.contentVerificationError ? ` contentVerificationError=${screenshot.contentVerificationError}` : ""}`;
}

/**
 * Objective filesystem snapshot of the workspace passed to the validator.
 *
 * Produced by `collectWorkspaceEvidence()`. Everything here is read from
 * disk and git — it does not depend on the agent's own turn output, so
 * the validator can see ground truth regardless of which CLI (Claude,
 * Codex, Gemini, Aider) produced the work. Codex in particular emits
 * `apply_patch` previews wrapped in TUI box-drawing that the validator
 * LLM can't reliably parse as evidence files actually exist.
 */
interface WorkspaceEvidence {
  workdir: string;
  /** Relative file paths (up to `fileLimit`), sorted for deterministic prompts. */
  files: string[];
  /** Total count of files found, including any truncated from `files`. */
  fileCount: number;
  /** True if `workdir` is inside a git working tree. */
  isGitRepo: boolean;
  /** `git status --short` output, trimmed. Empty string if not a git repo or clean. */
  gitStatus: string;
  /** `git diff --stat HEAD` output, trimmed. Empty if no diff or not a git repo. */
  gitDiffStat: string;
  /** Non-fatal collection errors we want to surface to the validator. */
  notes: string[];
}

export const WORKSPACE_EVIDENCE_FILE_LIMIT = 200;
export const WORKSPACE_EVIDENCE_MAX_DEPTH = 5;
// Hard ceiling on the total walk. We still report `fileCount` up to this
// number, but stop walking once we cross it so an enormous tree (e.g.
// someone passing `~` as workdir) can't wedge the validator.
export const WORKSPACE_EVIDENCE_MAX_WALK = 2_000;
const WORKSPACE_EVIDENCE_SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  "out",
  "target",
  ".turbo",
  "__pycache__",
  ".venv",
  "venv",
  ".DS_Store",
  ".cache",
]);

/**
 * Read the workspace filesystem to produce objective evidence for the
 * validator prompt.
 *
 * - Walks `workdir` up to `WORKSPACE_EVIDENCE_MAX_DEPTH` levels, skipping
 *   common build/dep directories.
 * - Caps the file list at `WORKSPACE_EVIDENCE_FILE_LIMIT` entries; the
 *   `fileCount` field still reflects the total discovered so the
 *   validator can see truncation happened.
 * - If `workdir` is a git repository, captures `git status --short` and
 *   `git diff --stat HEAD` so the validator can see uncommitted work.
 * - Never throws. All errors are captured in `notes` so the validator
 *   can judge whether missing evidence should downgrade the verdict.
 */
export async function collectWorkspaceEvidence(
  workdir: string | undefined | null,
): Promise<WorkspaceEvidence> {
  const evidence: WorkspaceEvidence = {
    workdir: workdir ?? "",
    files: [],
    fileCount: 0,
    isGitRepo: false,
    gitStatus: "",
    gitDiffStat: "",
    notes: [],
  };

  if (!workdir) {
    evidence.notes.push("no workdir supplied");
    return evidence;
  }

  // Resolve ~ and confirm the directory exists.
  const resolved = workdir.startsWith("~")
    ? path.join(homedir(), workdir.slice(1))
    : path.resolve(workdir);
  evidence.workdir = resolved;

  try {
    const rootStat = await stat(resolved);
    if (!rootStat.isDirectory()) {
      evidence.notes.push(`workdir is not a directory: ${resolved}`);
      return evidence;
    }
  } catch (err) {
    evidence.notes.push(
      `workdir not readable: ${err instanceof Error ? err.message : String(err)}`,
    );
    return evidence;
  }

  // Walk the tree breadth-first-ish and collect relative file paths.
  interface WalkEntry {
    name: string;
    isDirectory: () => boolean;
    isFile: () => boolean;
  }
  const collected: string[] = [];
  let totalCount = 0;
  let walkCeilingHit = false;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > WORKSPACE_EVIDENCE_MAX_DEPTH) return;
    if (totalCount >= WORKSPACE_EVIDENCE_MAX_WALK) {
      walkCeilingHit = true;
      return;
    }
    let entries: WalkEntry[];
    try {
      entries = (await readdir(dir, { withFileTypes: true })) as WalkEntry[];
    } catch {
      return;
    }
    for (const entry of entries) {
      if (WORKSPACE_EVIDENCE_SKIP_DIRS.has(entry.name)) continue;
      if (totalCount >= WORKSPACE_EVIDENCE_MAX_WALK) {
        walkCeilingHit = true;
        break;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.isFile()) {
        totalCount++;
        if (collected.length < WORKSPACE_EVIDENCE_FILE_LIMIT) {
          collected.push(path.relative(resolved, full));
        }
      }
    }
  };

  try {
    await walk(resolved, 0);
  } catch (err) {
    evidence.notes.push(
      `walk failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  collected.sort();
  evidence.files = collected;
  evidence.fileCount = totalCount;
  if (walkCeilingHit) {
    evidence.notes.push(
      `workspace walk hit the ${WORKSPACE_EVIDENCE_MAX_WALK}-file ceiling; counts and listing are truncated`,
    );
  }

  // Git evidence — best-effort, silent on failure.
  try {
    await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: resolved,
      timeout: 3_000,
    });
    evidence.isGitRepo = true;
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["status", "--short", "--untracked-files=all"],
        { cwd: resolved, timeout: 5_000, maxBuffer: 256 * 1024 },
      );
      evidence.gitStatus = stdout.trim();
    } catch {
      /* ignore */
    }
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["diff", "--stat", "HEAD"],
        { cwd: resolved, timeout: 5_000, maxBuffer: 256 * 1024 },
      );
      evidence.gitDiffStat = stdout.trim();
    } catch {
      // No HEAD yet (empty repo) or other error — fall back to a
      // full diff against the empty tree.
      try {
        const { stdout } = await execFileAsync("git", ["diff", "--stat"], {
          cwd: resolved,
          timeout: 5_000,
          maxBuffer: 256 * 1024,
        });
        evidence.gitDiffStat = stdout.trim();
      } catch {
        /* ignore */
      }
    }
  } catch {
    // Not a git repo, or git not installed. Both fine — filesystem
    // listing alone is still useful for scratch dirs.
  }

  return evidence;
}

function formatWorkspaceEvidence(evidence: WorkspaceEvidence): string {
  if (!evidence.workdir) return "- no workdir supplied";
  if (evidence.fileCount === 0 && evidence.notes.length > 0) {
    return `- workdir: ${evidence.workdir}\n- ${evidence.notes.join("\n- ")}`;
  }

  const lines: string[] = [];
  lines.push(`workdir: ${evidence.workdir}`);
  lines.push(
    `file count: ${evidence.fileCount}${
      evidence.files.length < evidence.fileCount
        ? ` (showing first ${evidence.files.length})`
        : ""
    }`,
  );
  if (evidence.files.length > 0) {
    lines.push("files:");
    for (const file of evidence.files) {
      lines.push(`  ${file}`);
    }
  } else {
    lines.push("files: (workspace is empty)");
  }
  if (evidence.isGitRepo) {
    lines.push(
      evidence.gitStatus
        ? `git status:\n${indent(evidence.gitStatus, "  ")}`
        : "git status: (clean or no changes)",
    );
    if (evidence.gitDiffStat) {
      lines.push(
        `git diff --stat HEAD:\n${indent(evidence.gitDiffStat, "  ")}`,
      );
    }
  }
  if (evidence.notes.length > 0) {
    lines.push(`notes: ${evidence.notes.join("; ")}`);
  }
  return lines.join("\n");
}

function indent(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function buildValidationPrompt(
  task: TaskContext,
  thread: TaskThreadDetail | null,
  completionReasoning: string,
  completionSummary: string,
  turnOutput: string,
  trajectories: TrajectoryListItem[],
  screenshot: ValidationScreenshotCapture,
  workspaceEvidence: WorkspaceEvidence,
): string {
  const acceptanceCriteria = thread?.acceptanceCriteria?.length
    ? thread.acceptanceCriteria.map((item) => `- ${item}`).join("\n")
    : "- Complete the user's request\n- Verify the result with available evidence\n- Do not claim success if important work is still missing";
  const completionExcerpt =
    turnOutput || completionSummary || completionReasoning || "none";
  const trajectoryBlock =
    trajectories.length > 0
      ? trajectories
          .map(
            (item) =>
              `- ${item.id} | status=${item.status} | llmCalls=${item.llmCallCount} | createdAt=${item.createdAt}`,
          )
          .join("\n")
      : "- none";
  const transcriptPreview =
    thread?.transcripts
      ?.slice(-8)
      .map((entry) => {
        const content = truncate(entry.content, 220);
        return `- [${entry.direction}] ${content}`;
      })
      .join("\n") ?? "- none";
  const artifactBlock =
    thread?.artifacts
      ?.slice(-8)
      .map((artifact) => {
        const locator = artifact.path ?? artifact.uri ?? "inline";
        return `- ${artifact.artifactType}: ${artifact.title} (${locator})`;
      })
      .join("\n") ?? "- none";

  return [
    "You are validating whether an orchestrated task is actually finished.",
    "Return JSON only with this shape:",
    JSON.stringify(
      {
        verdict: "pass",
        summary: "concise user-facing result",
        followUpPrompt: "only if verdict=revise",
        checklist: ["optional evidence note", "optional evidence note"],
      },
      null,
      2,
    ),
    "",
    `Task title: ${task.label}`,
    `Original request: ${task.originalTask}`,
    `Completion reasoning: ${completionReasoning || "none"}`,
    `Completion summary: ${completionSummary || "none"}`,
    "",
    "Acceptance criteria:",
    acceptanceCriteria,
    "",
    "Latest turn output excerpt:",
    truncate(completionExcerpt, 2400),
    "",
    "Recent transcript excerpt:",
    transcriptPreview,
    "",
    "Existing task artifacts:",
    artifactBlock,
    "",
    "Related trajectories:",
    trajectoryBlock,
    "",
    "Screenshot evidence:",
    describeScreenshotEvidence(screenshot),
    "",
    // Objective filesystem evidence. This is the ground truth — it does
    // NOT depend on the agent's own turn output, so it is reliable
    // regardless of which CLI produced the work. Use this as the
    // primary signal for "did files actually get created / modified".
    "Workspace evidence (read from disk):",
    formatWorkspaceEvidence(workspaceEvidence),
    "",
    "Rules:",
    "- Pass only if the task appears complete and the available evidence supports that claim.",
    "- When passing, write summary as the final result that can be shown to the requester. Use concrete facts from the transcript, artifacts, workspace evidence, screenshots, and trajectories. Preserve exact URLs and source links from the evidence when they are part of the result. Include important limitations or uncertainty. Do not describe the validation process.",
    "- Revise if the agent should keep working. In that case, provide a direct follow-up prompt.",
    "- Escalate if the task cannot be validated from available evidence and needs human review.",
    "- For information / question-answering / research tasks (no repo, no files expected), the completion summary IS the deliverable. Pass if the summary directly answers the original request with concrete content. Empty workspace evidence is expected for these and is not a failure signal.",
    "- For code / build tasks (repo set, or the request asks to create/edit/test files), missing tests or missing verification should usually mean revise or escalate, not pass.",
    "- Treat screenshot capture as artifact evidence only. A desktop screenshot may prove the UI rendered, but it does not semantically prove the task without supporting transcript, test, or trajectory evidence.",
    "- Trust the 'Workspace evidence' block over agent commentary: if files are listed there, they exist on disk, regardless of how the agent described its work. If the task was to create files and the workspace evidence shows them, that is strong evidence for pass.",
    "- Conversely, if the agent CLAIMS to have created files but the workspace evidence shows an empty directory or missing files, treat that as revise (not pass) — the agent's claim is unverified. This rule applies only when files were actually expected.",
  ].join("\n");
}

async function persistValidationReport(
  threadId: string,
  sessionId: string,
  report: Record<string, unknown>,
): Promise<string> {
  const dir = path.join(getValidationRootDir(), threadId);
  await mkdir(dir, { recursive: true });
  const reportPath = path.join(
    dir,
    `validation-${sessionId}-${Date.now()}.json`,
  );
  await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
  return reportPath;
}

export async function validateTaskCompletion(
  ctx: SwarmCoordinatorContext,
  input: ValidateTaskCompletionInput,
): Promise<TaskValidationResult> {
  const {
    sessionId,
    taskCtx,
    completionReasoning,
    completionSummary,
    turnOutput,
  } = input;
  const thread = await ctx.taskRegistry.getThread(taskCtx.threadId);
  const trajectories = await listRelevantTrajectories(
    ctx.runtime,
    taskCtx,
    thread,
  );
  const [screenshot, workspaceEvidence] = await Promise.all([
    captureValidationScreenshot(ctx.runtime, taskCtx, thread, sessionId),
    collectWorkspaceEvidence(taskCtx.workdir),
  ]);

  const prompt = buildValidationPrompt(
    taskCtx,
    thread,
    completionReasoning,
    completionSummary,
    turnOutput,
    trajectories,
    screenshot,
    workspaceEvidence,
  );
  const rawValidation = await withTrajectoryContext(
    ctx.runtime,
    {
      source: "orchestrator",
      decisionType: "task-validation",
      sessionId,
      taskLabel: taskCtx.label,
      repo: taskCtx.repo,
      workdir: taskCtx.workdir,
      originalTask: taskCtx.originalTask,
    },
    () => ctx.runtime.useModel(ModelType.TEXT_SMALL, { prompt }),
  );

  const parsed = parseValidationResponse(rawValidation);
  const verdict: ValidationResponse = parsed ?? {
    verdict: "escalate",
    summary:
      "Validation model returned an invalid response, so this task needs human review.",
  };

  const report = {
    version: 1,
    createdAt: new Date().toISOString(),
    threadId: taskCtx.threadId,
    sessionId,
    label: taskCtx.label,
    originalTask: taskCtx.originalTask,
    completionReasoning,
    completionSummary,
    verdict: verdict.verdict,
    summary: verdict.summary,
    followUpPrompt: verdict.followUpPrompt ?? null,
    acceptanceCriteria: thread?.acceptanceCriteria ?? [],
    evidence: {
      transcriptCount: thread?.transcripts.length ?? 0,
      decisionCount: thread?.decisions.length ?? 0,
      eventCount: thread?.events.length ?? 0,
      artifactCount: thread?.artifacts.length ?? 0,
      screenshot,
      trajectories: trajectories.map((item) => ({
        id: item.id,
        status: item.status,
        llmCallCount: item.llmCallCount,
        createdAt: item.createdAt,
      })),
      checklist: verdict.checklist ?? [],
      turnOutputExcerpt: truncate(
        turnOutput || completionSummary || completionReasoning || "",
      ),
    },
  };
  const reportPath = await persistValidationReport(
    taskCtx.threadId,
    sessionId,
    report,
  );

  const artifacts: TaskValidationResult["artifacts"] = [
    {
      artifactType: "validation_report",
      title: `Validation report for ${taskCtx.label}`,
      path: reportPath,
      mimeType: "application/json",
      metadata: {
        verdict: verdict.verdict,
        summary: verdict.summary,
      },
    },
    ...trajectories.map((item) => ({
      artifactType: "trajectory_link",
      title: `Trajectory ${item.id}`,
      uri: `/api/trajectories/${encodeURIComponent(item.id)}`,
      metadata: {
        trajectoryId: item.id,
        status: item.status,
        llmCallCount: item.llmCallCount,
      },
    })),
  ];

  if (screenshot.status === "captured") {
    artifacts.push({
      artifactType: "screenshot",
      title: `Validation screenshot for ${taskCtx.label}`,
      path: screenshot.path,
      mimeType: "image/png",
      metadata: {
        fileIntegrityVerified: screenshot.fileIntegrityVerified,
        sizeBytes: screenshot.sizeBytes,
        sha256: screenshot.sha256,
        captureScope: screenshot.captureScope,
        contentVerified: screenshot.contentVerified,
        ...(screenshot.contentSummary
          ? { contentSummary: screenshot.contentSummary }
          : {}),
        ...(screenshot.contentVerificationError
          ? {
              contentVerificationError: screenshot.contentVerificationError,
            }
          : {}),
      },
    });
  }

  return {
    verdict: verdict.verdict,
    summary: verdict.summary,
    ...(verdict.followUpPrompt
      ? { followUpPrompt: verdict.followUpPrompt }
      : {}),
    reportPath,
    artifacts,
  };
}

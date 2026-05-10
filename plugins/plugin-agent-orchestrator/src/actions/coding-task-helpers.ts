/**
 * Helper functions for the START_CODING_TASK action.
 *
 * - createScratchDir()      -- Creates a scratch sandbox directory for non-repo tasks
 * - generateLabel()         -- Generate a short semantic label from repo URL and/or task description
 * - registerSessionEvents() -- Register lifecycle event handlers for a spawned session
 *
 * @module actions/coding-task-helpers
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { type HandlerCallback, logger } from "@elizaos/core";
import { readConfigEnvKey } from "../services/config-env.js";
import type { PTYService } from "../services/pty-service.js";
import type { SkillSessionAllowList } from "../services/skill-callback-bridge.js";
import { getCodingWorkspaceService } from "../services/workspace-service.js";

/**
 * Sanitize a label into a safe directory name.
 * Strips non-alphanumeric chars (keeps hyphens), lowercases, truncates to 60 chars.
 */
function sanitizeDirName(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "scratch"
  );
}

/**
 * Find a non-colliding directory path by appending -2, -3, etc. if needed.
 */
function resolveNonColliding(baseDir: string, name: string): string {
  let candidate = path.join(baseDir, name);
  if (!fs.existsSync(candidate)) return candidate;
  for (let i = 2; i < 100; i++) {
    candidate = path.join(baseDir, `${name}-${i}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  // Fallback to uuid to guarantee uniqueness
  return path.join(baseDir, `${name}-${randomUUID().slice(0, 8)}`);
}

/**
 * Create a scratch sandbox directory for non-repo tasks.
 *
 * When `PARALLAX_CODING_DIRECTORY` is set (e.g. `~/Projects`), creates a
 * named subdir like `~/Projects/todo-app/` derived from the task label.
 * Otherwise falls back to `~/.eliza/workspaces/{uuid}`.
 */
export function createScratchDir(
  runtime?: IAgentRuntime,
  label?: string,
): string {
  // Check for user-configured coding directory.
  // Try runtime settings → config file env → process.env (in priority order).
  // Config file is checked directly because runtime.getSetting() doesn't read
  // the config env section, and process.env is only set at boot time.
  const codingDir =
    (runtime?.getSetting("PARALLAX_CODING_DIRECTORY") as string) ??
    readConfigEnvKey("PARALLAX_CODING_DIRECTORY") ??
    process.env.PARALLAX_CODING_DIRECTORY;

  if (codingDir?.trim()) {
    const resolved = codingDir.startsWith("~")
      ? path.join(os.homedir(), codingDir.slice(1))
      : path.resolve(codingDir);
    const dirName = label
      ? sanitizeDirName(label)
      : `scratch-${randomUUID().slice(0, 8)}`;
    const scratchDir = resolveNonColliding(resolved, dirName);
    fs.mkdirSync(scratchDir, { recursive: true });
    return scratchDir;
  }

  // Default: ephemeral UUID-based dir
  const baseDir = path.join(os.homedir(), ".eliza", "workspaces");
  const scratchId = randomUUID();
  const scratchDir = path.join(baseDir, scratchId);
  fs.mkdirSync(scratchDir, { recursive: true });
  return scratchDir;
}

/**
 * Generate a short semantic label from repo URL and/or task description.
 * e.g. "git-workspace-service-testbed/hello-mima" or "scratch/react-research"
 */
export function generateLabel(
  repo: string | undefined,
  task: string | undefined,
): string {
  const parts: string[] = [];

  if (repo) {
    // Extract repo name from URL: "https://github.com/owner/my-repo.git" -> "my-repo"
    const match = repo.match(/\/([^/]+?)(?:\.git)?$/);
    parts.push(match ? match[1] : "repo");
  } else {
    parts.push("scratch");
  }

  if (task) {
    // Extract a slug from the first few meaningful words of the task
    const slug = task
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .split(/\s+/)
      .filter(
        (w) =>
          w.length > 2 &&
          !["the", "and", "for", "with", "that", "this", "from"].includes(w),
      )
      .slice(0, 3)
      .join("-");
    if (slug) parts.push(slug);
  }

  return parts.join("/");
}

/**
 * Register lifecycle event handlers for a spawned session.
 *
 * When `coordinatorActive` is true the SwarmCoordinator owns chat messaging
 * and session lifecycle for blocked / task_complete / error events.
 * This listener still handles scratch-dir cleanup regardless.
 */
export function registerSessionEvents(
  ptyService: PTYService,
  runtime: IAgentRuntime,
  sessionId: string,
  label: string,
  scratchDir: string | null,
  callback?: HandlerCallback,
  coordinatorActive = false,
  skillSessionAllowList?: SkillSessionAllowList,
): void {
  let scratchRegistered = false;
  ptyService.onSessionEvent((sid, event, data) => {
    if (sid !== sessionId) return;

    // Clear per-session skill allow-list on terminal events so the entry
    // doesn't linger after the PTY session is gone.
    if (
      skillSessionAllowList &&
      (event === "stopped" || event === "task_complete" || event === "error")
    ) {
      skillSessionAllowList.clear(sessionId);
    }

    // No chat messages on `blocked` or `task_complete` regardless of the
    // coordinatorActive flag. The SwarmCoordinator runs in parallel and
    // owns user-facing delivery: blocking prompts (Bypass Permissions,
    // trust dialogs, tool permissions) are auto-resolved within ~1s, and
    // the swarm-complete callback emits a single combined synthesis once
    // all swarm tasks reach terminal state. Posting per-agent
    // "Agent X completed the task" messages here produced noisy duplicate
    // chatter and a leak of raw subagent output before the synthesis ran,
    // most visibly when SPAWN_AGENT redirected a multi-intent prompt
    // through START_CODING_TASK and the first finished sub-agent fired its own
    // "completed" callback ahead of the combined synthesis.
    //
    // task_complete intentionally does NOT force-kill the session here:
    // it fires after every tool call when the prompt reappears, not only
    // when the agent is truly finished. Killing here would reap the agent
    // mid-work (e.g. after WebSearch but before composing the answer).
    // The session is cleaned up by the idle watchdog after 5 minutes of
    // real inactivity, or when the agent naturally exits.
    if (!coordinatorActive && event === "error" && callback) {
      callback({
        text: `Agent "${label}" encountered an error: ${(data as { message?: string }).message ?? "unknown error"}`,
      });
    }

    // Scratch lifecycle: register terminal scratch workspaces for retention
    // policy handling (ephemeral / pending_decision / persistent).
    if (
      (event === "stopped" || event === "task_complete" || event === "error") &&
      scratchDir &&
      !scratchRegistered
    ) {
      logger.info(
        `[scratch-lifecycle] Terminal event "${event}" for "${label}": registering scratch workspace at ${scratchDir}`,
      );
      const wsService = getCodingWorkspaceService(runtime);
      if (!wsService) {
        logger.warn(
          `[scratch-lifecycle] CODING_WORKSPACE_SERVICE not found, cannot register scratch workspace`,
        );
        // Leave scratchRegistered false so a later event can retry
      } else {
        wsService
          .registerScratchWorkspace(sessionId, scratchDir, label, event)
          .then(() => {
            scratchRegistered = true;
          })
          .catch((err: unknown) => {
            logger.warn(
              `[START_CODING_TASK] Failed to register scratch workspace for "${label}": ${err}`,
            );
            // Leave scratchRegistered false so a later event can retry
          });
      }
    }
  });
}

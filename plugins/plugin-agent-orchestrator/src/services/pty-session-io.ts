/**
 * Session I/O helpers — extracted from PTYService for maintainability.
 *
 * Standalone functions for sending input/keys to sessions and stopping
 * sessions. Each function takes a {@link SessionIOContext} that provides
 * the manager instance and shared state maps.
 *
 * @module services/pty-session-io
 */

import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  BunCompatiblePTYManager,
  PTYManager,
  SessionMessage,
} from "pty-manager";

/**
 * Shared context required by all session I/O functions.
 * Built inline from PTYService instance fields.
 */
export interface SessionIOContext {
  manager: PTYManager | BunCompatiblePTYManager;
  usingBunWorker: boolean;
  sessionOutputBuffers: Map<string, string[]>;
  taskResponseMarkers: Map<string, number>;
  outputUnsubscribers: Map<string, () => void>;
}

/**
 * Send text input to a session.
 *
 * Marks the buffer position for task response capture, then writes the
 * input via the appropriate manager API.
 */
export async function sendToSession(
  ctx: SessionIOContext,
  sessionId: string,
  input: string,
): Promise<SessionMessage | undefined> {
  const session = ctx.manager.get(sessionId);
  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }

  // Mark buffer position for task response capture
  const buffer = ctx.sessionOutputBuffers.get(sessionId);
  if (buffer) {
    ctx.taskResponseMarkers.set(sessionId, buffer.length);
  }

  if (ctx.usingBunWorker) {
    // BunCompatiblePTYManager.send returns void
    await (ctx.manager as BunCompatiblePTYManager).send(sessionId, input);
    return;
  } else {
    // PTYManager.send returns SessionMessage
    return (ctx.manager as PTYManager).send(sessionId, input);
  }
}

/**
 * Send key sequences to a session (for special keys like arrows, enter, etc.).
 */
export async function sendKeysToSession(
  ctx: SessionIOContext,
  sessionId: string,
  keys: string | string[],
): Promise<void> {
  if (ctx.usingBunWorker) {
    await (ctx.manager as BunCompatiblePTYManager).sendKeys(sessionId, keys);
  } else {
    const ptySession = (ctx.manager as PTYManager).getSession(sessionId);
    if (!ptySession) {
      throw new Error(`Session ${sessionId} not found`);
    }
    ptySession.sendKeys(keys);
  }
}

/**
 * Stop a PTY session and clean up all associated state.
 *
 * @param force - When true, sends SIGKILL immediately instead of SIGTERM.
 *   Use for sessions whose task is already complete — there's nothing to save.
 */
export async function stopSession(
  ctx: SessionIOContext,
  sessionId: string,
  sessionMetadata: Map<string, Record<string, unknown>>,
  sessionWorkdirs: Map<string, string>,
  log: (msg: string) => void,
  force = false,
): Promise<void> {
  try {
    const session = ctx.manager.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    if (ctx.usingBunWorker) {
      if (force) {
        await (ctx.manager as BunCompatiblePTYManager).kill(
          sessionId,
          "SIGKILL",
        );
      } else {
        await (ctx.manager as BunCompatiblePTYManager).kill(sessionId);
      }
    } else {
      if (force) {
        await (ctx.manager as PTYManager).stop(sessionId, { force: true });
      } else {
        await (ctx.manager as PTYManager).stop(sessionId);
      }
    }
  } finally {
    // Clean up state even if the kill/stop call throws or the session was
    // already gone — prevents leaked subscribers and stale metadata.
    try {
      const unsubscribe = ctx.outputUnsubscribers.get(sessionId);
      if (unsubscribe) {
        unsubscribe();
      }
    } catch {
      // Ignore — unsubscribe may fail on a destroyed session
    }
    ctx.outputUnsubscribers.delete(sessionId);

    // Remove injected hooks from agent settings so they don't
    // leak to other CLI instances using the same workdir.
    const workdir = sessionWorkdirs.get(sessionId);
    if (workdir) {
      try {
        await cleanupAgentHooks(workdir, log);
      } catch {
        // Best-effort — don't block shutdown
      }
    }

    const metadata = sessionMetadata.get(sessionId);
    const codexExecOutputDir = metadata?.codexExecOutputDir;
    if (typeof codexExecOutputDir === "string") {
      try {
        await rm(codexExecOutputDir, { recursive: true, force: true });
      } catch (err) {
        log(
          `Failed to remove Codex exec output dir ${codexExecOutputDir}: ${err}`,
        );
      }
    }

    sessionMetadata.delete(sessionId);
    sessionWorkdirs.delete(sessionId);
    ctx.sessionOutputBuffers.delete(sessionId);
    ctx.taskResponseMarkers.delete(sessionId);
    log(`Stopped session ${sessionId}`);
  }
}

/**
 * Remove injected hooks from a workspace's agent settings files.
 * Cleans both .claude/settings.json and .gemini/settings.json.
 * Best-effort — errors are logged but not thrown.
 */
async function cleanupAgentHooks(
  workdir: string,
  log: (msg: string) => void,
): Promise<void> {
  const settingsPaths = [
    join(workdir, ".claude", "settings.json"),
    join(workdir, ".gemini", "settings.json"),
  ];
  for (const settingsPath of settingsPaths) {
    try {
      const raw = await readFile(settingsPath, "utf-8");
      const settings = JSON.parse(raw) as Record<string, unknown>;
      if (!settings.hooks) continue;
      delete settings.hooks;
      await writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
      log(`Cleaned up hooks from ${settingsPath}`);
    } catch (err: unknown) {
      // ENOENT (file doesn't exist) is expected — silently ignore.
      // Other errors (parse failure, permission denied) are logged.
      const code = (err as { code?: string }).code;
      if (code !== "ENOENT") {
        log(`Failed to clean up hooks from ${settingsPath}: ${err}`);
      }
    }
  }
}

/**
 * Subscribe to live output from a session.
 * Returns an unsubscribe function.
 */
export function subscribeToOutput(
  ctx: SessionIOContext,
  sessionId: string,
  callback: (data: string) => void,
): () => void {
  if (ctx.usingBunWorker) {
    const unsubscribe = (ctx.manager as BunCompatiblePTYManager).onSessionData(
      sessionId,
      callback,
    );
    ctx.outputUnsubscribers.set(sessionId, unsubscribe);
    return unsubscribe;
  }
  const ptySession = (ctx.manager as PTYManager).getSession(sessionId);
  if (!ptySession) {
    throw new Error(`Session ${sessionId} not found`);
  }
  ptySession.on("output", callback);
  const unsubscribe = () => ptySession.off("output", callback);
  ctx.outputUnsubscribers.set(sessionId, unsubscribe);
  return unsubscribe;
}

/**
 * Get buffered or logged output from a session.
 */
export async function getSessionOutput(
  ctx: SessionIOContext,
  sessionId: string,
  lines?: number,
): Promise<string> {
  if (ctx.usingBunWorker) {
    const buffer = ctx.sessionOutputBuffers.get(sessionId);
    if (!buffer) return "";
    const tail = lines ?? buffer.length;
    return buffer.slice(-tail).join("\n");
  }

  const output: string[] = [];
  for await (const line of (ctx.manager as PTYManager).logs(sessionId, {
    tail: lines,
  })) {
    output.push(line);
  }
  return output.join("\n");
}

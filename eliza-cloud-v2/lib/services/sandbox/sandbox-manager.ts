/**
 * Sandbox Manager - Admin utilities for managing sandbox instances.
 *
 * Uses Vercel Sandbox SDK features:
 * - Sandbox.list() to enumerate sandboxes
 * - Sandbox.get() to retrieve existing sandboxes
 * - command.logs() for streaming output
 */

import { logger } from "@/lib/utils/logger";

/**
 * Summary info returned by Sandbox.list()
 */
export interface SandboxSummary {
  sandboxId: string;
  status: "pending" | "running" | "stopping" | "stopped" | "failed";
  createdAt: Date;
  timeout: number;
}

/**
 * Pagination info for list results
 */
export interface SandboxPagination {
  next?: string;
  hasMore: boolean;
}

/**
 * Result from listing sandboxes
 */
export interface ListSandboxesResult {
  sandboxes: SandboxSummary[];
  pagination: SandboxPagination;
}

/**
 * Options for listing sandboxes
 */
export interface ListSandboxesOptions {
  projectId: string;
  limit?: number;
  since?: Date | number;
  until?: Date | number;
  signal?: AbortSignal;
}

/**
 * Options for getting a sandbox by ID
 */
export interface GetSandboxOptions {
  sandboxId: string;
  signal?: AbortSignal;
}

/**
 * Dynamically import the Sandbox SDK to avoid bundling issues
 */
async function getSandboxSDK() {
  try {
    const sandboxModule = await import("@vercel/sandbox");
    return sandboxModule.Sandbox || sandboxModule.default;
  } catch (error) {
    logger.error("Failed to import @vercel/sandbox", {
      error: error instanceof Error ? error.message : "Unknown",
    });
    throw new Error("Vercel Sandbox SDK not available");
  }
}

/**
 * List all sandboxes for a project.
 * Useful for admin dashboards and cleanup operations.
 */
export async function listSandboxes(
  options: ListSandboxesOptions,
): Promise<ListSandboxesResult> {
  const { projectId, limit = 50, since, until, signal } = options;

  try {
    const Sandbox = await getSandboxSDK();

    // Check if list method exists
    if (typeof Sandbox.list !== "function") {
      logger.warn("Sandbox.list() not available in current SDK version");
      return { sandboxes: [], pagination: { hasMore: false } };
    }

    const result = await Sandbox.list({
      projectId,
      limit,
      since,
      until,
      signal,
    });
    const parsedResult = "json" in result ? result.json : result;
    const sandboxes = parsedResult.sandboxes ?? [];
    const pagination = parsedResult.pagination;

    return {
      sandboxes: sandboxes.map((s: SandboxSummary) => ({
        sandboxId: s.sandboxId,
        status: s.status,
        createdAt: new Date(s.createdAt),
        timeout: s.timeout,
      })),
      pagination: {
        next: pagination?.next,
        hasMore: !!pagination?.next,
      },
    };
  } catch (error) {
    logger.error("Failed to list sandboxes", {
      projectId,
      error: error instanceof Error ? error.message : "Unknown",
    });
    throw error;
  }
}

/**
 * Get an existing sandbox by ID.
 * Useful for reconnecting to a sandbox after page refresh.
 */
export async function getSandbox(options: GetSandboxOptions) {
  const { sandboxId, signal } = options;

  try {
    const Sandbox = await getSandboxSDK();

    // Check if get method exists
    if (typeof Sandbox.get !== "function") {
      logger.warn("Sandbox.get() not available in current SDK version");
      return null;
    }

    return await Sandbox.get({ sandboxId, signal });
  } catch (error) {
    logger.error("Failed to get sandbox", {
      sandboxId,
      error: error instanceof Error ? error.message : "Unknown",
    });
    return null;
  }
}

/**
 * Find and stop stale sandboxes (older than maxAge).
 * Returns count of sandboxes stopped.
 */
export async function cleanupStaleSandboxes(options: {
  projectId: string;
  maxAgeMs?: number;
  signal?: AbortSignal;
}): Promise<{ stopped: number; failed: number; skipped: number }> {
  const { projectId, maxAgeMs = 60 * 60 * 1000, signal } = options; // Default 1 hour
  const cutoff = new Date(Date.now() - maxAgeMs);

  const result = { stopped: 0, failed: 0, skipped: 0 };

  try {
    const { sandboxes } = await listSandboxes({
      projectId,
      until: cutoff,
      limit: 100,
      signal,
    });

    for (const summary of sandboxes) {
      if (signal?.aborted) break;

      if (summary.status === "stopped" || summary.status === "failed") {
        result.skipped++;
        continue;
      }

      try {
        const sandbox = await getSandbox({
          sandboxId: summary.sandboxId,
          signal,
        });
        if (sandbox) {
          await sandbox.stop({ signal });
          result.stopped++;
          logger.info("Stopped stale sandbox", {
            sandboxId: summary.sandboxId,
            age: Date.now() - summary.createdAt.getTime(),
          });
        }
      } catch (error) {
        result.failed++;
        logger.warn("Failed to stop sandbox", {
          sandboxId: summary.sandboxId,
          error: error instanceof Error ? error.message : "Unknown",
        });
      }
    }

    return result;
  } catch (error) {
    logger.error("Failed to cleanup stale sandboxes", {
      projectId,
      error: error instanceof Error ? error.message : "Unknown",
    });
    return result;
  }
}

/**
 * Stream command logs in real-time.
 * Uses command.logs() for efficient log streaming.
 */
export async function* streamCommandLogs(
  command: {
    logs: (opts?: {
      signal?: AbortSignal;
    }) => AsyncGenerator<{ stream: "stdout" | "stderr"; data: string }>;
  },
  options?: { signal?: AbortSignal },
): AsyncGenerator<{ stream: "stdout" | "stderr"; data: string }> {
  try {
    for await (const log of command.logs(options)) {
      yield log;
    }
  } catch (error) {
    // Check if it's an abort error
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("abort") || message.includes("cancel")) {
      return;
    }
    throw error;
  }
}

/**
 * Collect all command output as a string using logs() streaming.
 * More memory-efficient for large outputs.
 */
export async function collectCommandOutput(
  command: {
    logs: (opts?: {
      signal?: AbortSignal;
    }) => AsyncGenerator<{ stream: "stdout" | "stderr"; data: string }>;
  },
  options?: {
    signal?: AbortSignal;
    stream?: "stdout" | "stderr" | "both";
    maxLength?: number;
  },
): Promise<string> {
  const { signal, stream = "both", maxLength = 100000 } = options ?? {};
  const chunks: string[] = [];
  let length = 0;

  try {
    for await (const log of command.logs({ signal })) {
      if (stream !== "both" && log.stream !== stream) continue;

      if (length + log.data.length > maxLength) {
        // Truncate if exceeding max length
        const remaining = maxLength - length;
        if (remaining > 0) {
          chunks.push(log.data.substring(0, remaining));
        }
        chunks.push("\n... [output truncated]");
        break;
      }

      chunks.push(log.data);
      length += log.data.length;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("abort") && !message.includes("cancel")) {
      throw error;
    }
  }

  return chunks.join("");
}

/**
 * Get sandbox stats for monitoring.
 */
export async function getSandboxStats(projectId: string): Promise<{
  total: number;
  running: number;
  pending: number;
  stopped: number;
  failed: number;
}> {
  const stats = { total: 0, running: 0, pending: 0, stopped: 0, failed: 0 };

  try {
    const { sandboxes } = await listSandboxes({ projectId, limit: 100 });

    for (const sandbox of sandboxes) {
      stats.total++;
      switch (sandbox.status) {
        case "running":
          stats.running++;
          break;
        case "pending":
          stats.pending++;
          break;
        case "stopped":
        case "stopping":
          stats.stopped++;
          break;
        case "failed":
          stats.failed++;
          break;
      }
    }

    return stats;
  } catch (error) {
    logger.error("Failed to get sandbox stats", {
      projectId,
      error: error instanceof Error ? error.message : "Unknown",
    });
    return stats;
  }
}

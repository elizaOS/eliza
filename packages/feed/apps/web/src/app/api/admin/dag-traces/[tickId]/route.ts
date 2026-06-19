/**
 * DAG Trace detail API
 *
 * @route GET /api/admin/dag-traces/[tickId] - Get full trace for a specific tick
 * @access Admin
 *
 * Query params:
 *   ?include=llm-calls    - Inline full LLM call data
 *   ?include=nodes         - Inline full node data
 *   ?include=npc           - Inline NPC trajectory data
 *   ?include=all           - Inline everything
 *   ?llmCallId=call-001-x  - Get a specific LLM call file
 *   ?nodeFile=01-init       - Get a specific node file
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { requireAdmin, successResponse, withErrorHandling } from "@feed/api";
import type { NextRequest } from "next/server";

const TRACE_DIR = path.resolve(process.cwd(), "runs", "dag-traces");

export const GET = withErrorHandling(
  async (
    request: NextRequest,
    { params }: { params: Promise<{ tickId: string }> },
  ) => {
    await requireAdmin(request);

    const { tickId } = await params;
    const url = new URL(request.url);
    const include = url.searchParams.get("include") ?? "";
    const llmCallId = url.searchParams.get("llmCallId");
    const nodeFile = url.searchParams.get("nodeFile");

    // Find the trace directory - search by dirName containing tickId
    const traceDir = findTraceDir(tickId);
    if (!traceDir) {
      return Response.json({ error: "Trace not found" }, { status: 404 });
    }

    // Return specific LLM call
    if (llmCallId) {
      const callPath = path.join(traceDir, "llm-calls", `${llmCallId}.json`);
      if (!fs.existsSync(callPath)) {
        return Response.json({ error: "LLM call not found" }, { status: 404 });
      }
      return successResponse(JSON.parse(fs.readFileSync(callPath, "utf-8")));
    }

    // Return specific node
    if (nodeFile) {
      const nodesDir = path.join(traceDir, "nodes");
      const files = fs
        .readdirSync(nodesDir)
        .filter((f) => f.includes(nodeFile));
      if (files.length === 0) {
        return Response.json({ error: "Node file not found" }, { status: 404 });
      }
      return successResponse(
        JSON.parse(fs.readFileSync(path.join(nodesDir, files[0]!), "utf-8")),
      );
    }

    // Load summary
    const summaryPath = path.join(traceDir, "tick-summary.json");
    if (!fs.existsSync(summaryPath)) {
      return Response.json({ error: "Summary not found" }, { status: 404 });
    }

    const summary = JSON.parse(fs.readFileSync(summaryPath, "utf-8"));
    const includeAll = include === "all";

    // Optionally inline full LLM calls
    if (includeAll || include.includes("llm-calls")) {
      const llmDir = path.join(traceDir, "llm-calls");
      if (fs.existsSync(llmDir)) {
        summary.llmCallsFull = fs
          .readdirSync(llmDir)
          .filter((f) => f.endsWith(".json"))
          .map((f) =>
            JSON.parse(fs.readFileSync(path.join(llmDir, f), "utf-8")),
          );
      }
    }

    // Optionally inline full node data
    if (includeAll || include.includes("nodes")) {
      const nodesDir = path.join(traceDir, "nodes");
      if (fs.existsSync(nodesDir)) {
        summary.nodesFull = fs
          .readdirSync(nodesDir)
          .filter((f) => f.endsWith(".json"))
          .sort()
          .map((f) =>
            JSON.parse(fs.readFileSync(path.join(nodesDir, f), "utf-8")),
          );
      }
    }

    // Optionally inline NPC trajectories
    if (includeAll || include.includes("npc")) {
      const npcDir = path.join(traceDir, "npc-trajectories");
      if (fs.existsSync(npcDir)) {
        summary.npcTrajectories = fs
          .readdirSync(npcDir)
          .filter((f) => f.endsWith(".json"))
          .map((f) =>
            JSON.parse(fs.readFileSync(path.join(npcDir, f), "utf-8")),
          );
      }
    }

    return successResponse(summary);
  },
);

function findTraceDir(tickId: string): string | null {
  if (!fs.existsSync(TRACE_DIR)) return null;

  // Direct match
  const direct = path.join(TRACE_DIR, tickId);
  if (fs.existsSync(direct) && fs.statSync(direct).isDirectory()) {
    return direct;
  }

  // Search by prefix
  const entries = fs
    .readdirSync(TRACE_DIR)
    .filter(
      (e) =>
        e.includes(tickId) &&
        fs.statSync(path.join(TRACE_DIR, e)).isDirectory(),
    );

  if (entries.length > 0) {
    return path.join(TRACE_DIR, entries[0]!);
  }

  // Try 'latest' symlink
  if (tickId === "latest") {
    const latestLink = path.join(TRACE_DIR, "latest");
    if (fs.existsSync(latestLink)) {
      return fs.realpathSync(latestLink);
    }
  }

  return null;
}

/**
 * Writes TickTrace data to disk as organized JSON files.
 *
 * Output structure:
 *   runs/dag-traces/
 *     tick-{timestamp}-{number}/
 *       tick-summary.json       # DAG structure + node metadata (LLM calls by reference only)
 *       nodes/
 *         01-init.json
 *         02-bootstrap.json
 *         ...
 *       llm-calls/
 *         call-001-npc-market-decisions.json
 *         ...
 *       npc-trajectories/
 *         {npc-name}.json
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { logger } from '@babylon/shared';
import type { TickTrace } from './types';

const TRACE_DIR = path.resolve(process.cwd(), 'runs', 'dag-traces');
const MAX_TRACES = Number(process.env.BABYLON_DAG_TRACE_KEEP || 100);

export async function writeTickTrace(trace: TickTrace): Promise<string> {
  const dirName = `tick-${trace.timestamp.replace(/[:.]/g, '-')}-${trace.tickNumber}`;
  const traceDir = path.join(TRACE_DIR, dirName);

  try {
    // Create directories
    fs.mkdirSync(path.join(traceDir, 'nodes'), { recursive: true });
    fs.mkdirSync(path.join(traceDir, 'llm-calls'), { recursive: true });
    fs.mkdirSync(path.join(traceDir, 'npc-trajectories'), { recursive: true });

    // Write tick summary (no inline LLM prompt text - just references)
    const summary = {
      tickId: trace.tickId,
      tickNumber: trace.tickNumber,
      timestamp: trace.timestamp,
      startMs: trace.startMs,
      endMs: trace.endMs,
      durationMs: trace.durationMs,
      dag: trace.dag,
      environmentFlags: trace.environmentFlags,
      nodes: trace.nodes.map((n) => ({
        ...n,
        // Summarize inputs/outputs for quick loading, preserving structure
        inputs: summarizeData(n.inputs),
        outputs: summarizeData(n.outputs),
      })),
      llmCallSummaries: trace.llmCalls.map((c) => ({
        callId: c.callId,
        nodeId: c.nodeId,
        promptType: c.promptType,
        provider: c.provider,
        model: c.model,
        inputTokens: c.inputTokens,
        outputTokens: c.outputTokens,
        durationMs: c.durationMs,
        success: c.success,
      })),
      npcTrajectoryCount: trace.npcTrajectories.length,
      tokenStats: trace.tokenStats,
      gameTickResult: trace.gameTickResult,
    };
    fs.writeFileSync(
      path.join(traceDir, 'tick-summary.json'),
      JSON.stringify(summary, null, 2)
    );

    // Write individual node files with full data
    for (let i = 0; i < trace.nodes.length; i++) {
      const node = trace.nodes[i]!;
      const filename = `${String(i + 1).padStart(2, '0')}-${node.nodeId}.json`;
      fs.writeFileSync(
        path.join(traceDir, 'nodes', filename),
        JSON.stringify(node, null, 2)
      );
    }

    // Write individual LLM call files with full prompt/response text
    for (const call of trace.llmCalls) {
      fs.writeFileSync(
        path.join(traceDir, 'llm-calls', `${call.callId}.json`),
        JSON.stringify(call, null, 2)
      );
    }

    // Write NPC trajectory files
    for (const npc of trace.npcTrajectories) {
      const safeName = npc.npcName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      fs.writeFileSync(
        path.join(traceDir, 'npc-trajectories', `${safeName}.json`),
        JSON.stringify(npc, null, 2)
      );
    }

    // Update latest symlink
    const latestLink = path.join(TRACE_DIR, 'latest');
    try {
      if (fs.existsSync(latestLink)) fs.unlinkSync(latestLink);
      fs.symlinkSync(dirName, latestLink);
    } catch {
      // Symlinks may not work on all platforms
    }

    // Cleanup old traces
    await cleanupOldTraces();

    logger.info(
      `DAG trace written`,
      {
        dir: dirName,
        nodes: trace.nodes.length,
        llmCalls: trace.llmCalls.length,
        npcTrajectories: trace.npcTrajectories.length,
      },
      'DagTrace'
    );

    return traceDir;
  } catch (err) {
    logger.error(
      'Failed to write DAG trace',
      err instanceof Error ? err : new Error(String(err)),
      'DagTrace'
    );
    return traceDir;
  }
}

/**
 * Summarize data for tick-summary.json.
 * Preserves structure (key names, array lengths, scalar values) while
 * reducing size. Full data lives in individual node files.
 */
function summarizeData(data: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === 'string' && value.length > 200) {
      result[key] = value.slice(0, 200) + `... [${value.length} chars]`;
    } else if (Array.isArray(value)) {
      result[key] = {
        _summary: true,
        type: 'array',
        length: value.length,
        preview: value.slice(0, 3).map((item) =>
          typeof item === 'object' && item !== null
            ? Object.fromEntries(
                Object.entries(item)
                  .slice(0, 5)
                  .map(([k, v]) => [
                    k,
                    typeof v === 'string' && v.length > 100
                      ? v.slice(0, 100) + '...'
                      : v,
                  ])
              )
            : item
        ),
      };
    } else if (typeof value === 'object' && value !== null) {
      const entries = Object.entries(value);
      result[key] = {
        _summary: true,
        type: 'object',
        keys: entries.map(([k]) => k),
        preview: Object.fromEntries(
          entries.slice(0, 5).map(([k, v]) => {
            if (typeof v === 'string' && v.length > 100)
              return [k, v.slice(0, 100) + '...'];
            if (typeof v === 'object' && v !== null)
              return [k, Array.isArray(v) ? `[${v.length} items]` : '{...}'];
            return [k, v];
          })
        ),
      };
    } else {
      result[key] = value;
    }
  }
  return result;
}

async function cleanupOldTraces(): Promise<void> {
  try {
    if (!fs.existsSync(TRACE_DIR)) return;

    const entries = fs
      .readdirSync(TRACE_DIR)
      .filter(
        (e) =>
          e.startsWith('tick-') &&
          fs.statSync(path.join(TRACE_DIR, e)).isDirectory()
      )
      .sort()
      .reverse();

    if (entries.length > MAX_TRACES) {
      for (const old of entries.slice(MAX_TRACES)) {
        fs.rmSync(path.join(TRACE_DIR, old), { recursive: true, force: true });
      }
    }
  } catch {
    // Non-critical, ignore cleanup errors
  }
}

/**
 * DAG Trace listing API
 *
 * @route GET /api/admin/dag-traces - List available tick traces
 * @access Admin
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { requireAdmin, successResponse, withErrorHandling } from '@feed/api';
import type { NextRequest } from 'next/server';

const TRACE_DIR = path.resolve(process.cwd(), 'runs', 'dag-traces');

export const GET = withErrorHandling(async (request: NextRequest) => {
  await requireAdmin(request);

  if (!fs.existsSync(TRACE_DIR)) {
    return successResponse({
      traces: [],
      message: 'No traces found. Enable with FEED_DAG_TRACE=true',
    });
  }

  const entries = fs
    .readdirSync(TRACE_DIR)
    .filter(
      (e) =>
        e.startsWith('tick-') &&
        fs.statSync(path.join(TRACE_DIR, e)).isDirectory()
    )
    .sort()
    .reverse();

  const traces = entries.map((dirName) => {
    const summaryPath = path.join(TRACE_DIR, dirName, 'tick-summary.json');
    if (!fs.existsSync(summaryPath)) {
      return { dirName, tickId: dirName, error: 'missing tick-summary.json' };
    }

    try {
      const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf-8'));
      return {
        dirName,
        tickId: summary.tickId,
        tickNumber: summary.tickNumber,
        timestamp: summary.timestamp,
        durationMs: summary.durationMs,
        nodeCount: summary.nodes?.length ?? 0,
        llmCallCount: summary.llmCallSummaries?.length ?? 0,
        npcTrajectoryCount: summary.npcTrajectoryCount ?? 0,
        tokenStats: summary.tokenStats,
      };
    } catch {
      return { dirName, tickId: dirName, error: 'failed to parse summary' };
    }
  });

  return successResponse({ traces });
});

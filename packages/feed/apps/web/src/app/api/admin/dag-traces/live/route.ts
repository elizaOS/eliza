/**
 * DAG Trace SSE (Server-Sent Events) endpoint for live tick streaming.
 *
 * @route GET /api/admin/dag-traces/live - Stream live tick trace updates
 * @access Admin
 *
 * Polls the trace directory every 2s and sends new traces as they appear.
 * Also emits in-progress node updates during active tick execution.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { requireAdmin, withErrorHandling } from '@feed/api';
import type { NextRequest } from 'next/server';

const TRACE_DIR = path.resolve(process.cwd(), 'runs', 'dag-traces');

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export const GET = withErrorHandling(async (request: NextRequest) => {
  await requireAdmin(request);

  const encoder = new TextEncoder();
  let lastSeen = '';
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
          );
        } catch {
          closed = true;
        }
      };

      // Send initial state
      send('connected', { timestamp: Date.now() });

      const poll = () => {
        if (closed) return;

        try {
          if (!fs.existsSync(TRACE_DIR)) {
            send('status', { waiting: true, message: 'No traces yet' });
            return;
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

          if (entries.length === 0) {
            send('status', { waiting: true, message: 'No traces yet' });
            return;
          }

          const newest = entries[0]!;

          // New trace appeared
          if (newest !== lastSeen) {
            lastSeen = newest;
            const summaryPath = path.join(
              TRACE_DIR,
              newest,
              'tick-summary.json'
            );
            if (fs.existsSync(summaryPath)) {
              try {
                const summary = JSON.parse(
                  fs.readFileSync(summaryPath, 'utf-8')
                );
                send('new-trace', {
                  dirName: newest,
                  tickId: summary.tickId,
                  tickNumber: summary.tickNumber,
                  timestamp: summary.timestamp,
                  durationMs: summary.durationMs,
                  nodeCount: summary.nodes?.length ?? 0,
                  llmCallCount: summary.llmCallSummaries?.length ?? 0,
                  nodes: summary.nodes,
                  llmCallSummaries: summary.llmCallSummaries,
                  tokenStats: summary.tokenStats,
                  gameTickResult: summary.gameTickResult,
                });
              } catch {
                send('new-trace', { dirName: newest, partial: true });
              }
            }
          }

          // Send heartbeat with trace count
          send('heartbeat', {
            traceCount: entries.length,
            latest: newest,
            timestamp: Date.now(),
          });
        } catch {
          // Ignore errors during poll
        }
      };

      // Poll every 2 seconds
      const interval = setInterval(poll, 2000);
      poll(); // immediate first poll

      // Clean up on close
      request.signal.addEventListener('abort', () => {
        closed = true;
        clearInterval(interval);
        try {
          controller.close();
        } catch {
          // already closed
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
});

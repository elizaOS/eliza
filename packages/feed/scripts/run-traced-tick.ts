#!/usr/bin/env bun
/**
 * Standalone script to run a traced game tick.
 * Writes trace data to runs/dag-traces/ for the visualizer.
 *
 * Usage: BABYLON_DAG_TRACE=true bun run scripts/run-traced-tick.ts
 */

import 'dotenv/config';

// Force enable tracing
process.env.BABYLON_DAG_TRACE = 'true';

import { executeGameTick } from '@babylon/engine';
import { logger } from '@babylon/shared';

async function main() {
  logger.info('Starting traced game tick...', {}, 'TracedTick');

  const start = Date.now();
  try {
    const result = await executeGameTick();
    const durationMs = Date.now() - start;

    logger.info(
      'Traced game tick completed',
      {
        durationMs,
        postsCreated: result.postsCreated,
        eventsCreated: result.eventsCreated,
        questionsCreated: result.questionsCreated,
        marketsUpdated: result.marketsUpdated,
      },
      'TracedTick'
    );

    // Check for trace output
    const fs = await import('node:fs');
    const path = await import('node:path');
    const traceDir = path.resolve(process.cwd(), 'runs', 'dag-traces');
    if (fs.existsSync(traceDir)) {
      const entries = fs
        .readdirSync(traceDir)
        .filter((e) => e.startsWith('tick-'))
        .sort()
        .reverse();
      logger.info(
        `Trace files saved: ${entries.length} traces in runs/dag-traces/`,
        {
          latest: entries[0],
        },
        'TracedTick'
      );
    } else {
      logger.warn(
        'No trace directory found - tracing may not be enabled',
        {},
        'TracedTick'
      );
    }
  } catch (error) {
    logger.error(
      'Traced game tick failed',
      error instanceof Error ? error : new Error(String(error)),
      'TracedTick'
    );
  }

  process.exit(0);
}

main();

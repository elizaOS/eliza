import { runSmithersWorkflow } from '../../src/services/smithers-runtime';

const request = JSON.parse(process.argv[2]);
const result = await runSmithersWorkflow({
  ...request,
  ...(process.env.ELIZA_LEASE_TEST_STARTUP_DIAGNOSTICS === '1'
    ? {
        onStartupPhase: (phase: string) => {
          process.stdout.write(JSON.stringify({ phase }) + '\n');
        },
      }
    : {}),
  generate: async () => {
    throw Error('Unexpected parent model call');
  },
}).catch((error: unknown) => {
  if (process.env.ELIZA_LEASE_TEST_STARTUP_DIAGNOSTICS === '1') {
    let code = 'UNCLASSIFIED';
    try {
      const value = error instanceof Error && 'code' in error ? error.code : undefined;
      if (
        typeof value === 'string' &&
        [
          'SMTHRS_WORKER_SPAWN_FAILED',
          'SMTHRS_WORKER_PROCESS_FAILED',
          'SMTHRS_RESULT_MISSING',
          'WORKFLOW_WORKER_UNRESOLVED',
          'WORKFLOW_WORKER_OUTCOME_UNKNOWN',
          'WORKFLOW_WORKER_RUNNING',
        ].includes(value)
      )
        code = value;
    } catch {}
    process.stdout.write(JSON.stringify({ terminal: true, threw: true, code }) + '\n');
  }
  throw error;
});

if (process.env.ELIZA_LEASE_TEST_STARTUP_DIAGNOSTICS === '1')
  process.stdout.write(
    JSON.stringify({ terminal: true, status: result.status, hasError: !!result.error }) + '\n'
  );

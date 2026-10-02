import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { windowsWorkerLeaseScript } from '../../src/services/windows-worker-lease-resource';
import { workflowRuntimeFileCommand } from '../../src/services/workflow-process-host';
import { workerLeasePrelude } from '../../src/services/workflow-worker-lease-prelude';
import { windowsWorkflowBackend } from '../../src/services/workflow-worker-lease.windows';
import { instrumentLeasePrelude } from './lease-phase-instrumentation';

if (process.platform !== 'win32') throw Error('Real Windows host required');

const diagnosticCodes = [
  'WINDOWS_LEASE_STARTUP_DEADLINE',
  'WINDOWS_LEASE_COMPILE',
  'WINDOWS_LEASE_TRANSPORT',
  'WINDOWS_LEASE_HELPER_FAILED',
  'WINDOWS_LEASE_BOOTSTRAP',
  'WINDOWS_LEASE_PRIVATE_ACL',
  'WINDOWS_LEASE_STATE_OWNER',
  'WINDOWS_LEASE_STATE_ACL',
  'WINDOWS_LEASE_DIRECTORY',
  'WINDOWS_LEASE_RESERVATION',
  'WINDOWS_LEASE_WORKER',
  'WINDOWS_LEASE_PATH_KIND',
  'WINDOWS_LEASE_PATH_CANONICAL',
  'WINDOWS_LEASE_PATH_REPARSE',
  'WINDOWS_LEASE_INVALID_RESPONSE',
  'WINDOWS_LEASE_OUTPUT_LIMIT',
];
const diagnosticPhases = [
  'bootstrap',
  'source-read',
  'hash-verified',
  'compile-start',
  'compiled',
  'request-read',
  'reserved',
  'ready',
];
const topology = 'readline';

// Actual subprocess discrimination, not a mocked backend. The helper's production
// 15-second startup deadline is unchanged. No workflow or external effect runs.
for (const environment of ['inherited', 'restricted'] as const) {
  for (const helper of ['original', 'instrumented'] as const) {
    test(`Windows helper phases (${helper}): ${environment} environment, ${topology} stdin`, async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'windows-helper-startup-')));
      const resultPath = join(root, 'result.json');
      const payloadPath = join(root, `.run-${randomUUID()}.json`);
      const identity = {
        rootDir: root,
        socketRoot: root,
        runId: randomUUID(),
        versionId: 'startup-probe-v1',
        sourceSha256: createHash('sha256').update('owned startup probe; no workflow').digest('hex'),
      };
      writeFileSync(payloadPath, JSON.stringify(identity), { mode: 0o600 });
      const programPath = join(root, 'worker.mjs');
      writeFileSync(
        programPath,
        `${helper === 'original' ? workerLeasePrelude : instrumentLeasePrelude(workerLeasePrelude, windowsWorkerLeaseScript)}
import {readFileSync,writeFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
const input=createInterface({input:process.stdin,crlfDelay:Infinity});
if(input)input.on('line',()=>{});
const save=(value)=>writeFileSync(${JSON.stringify(resultPath)},JSON.stringify(value),{mode:0o600});
let phase='acquire';
const phases=[];
globalThis.__leaseProbePhase=(p)=>{if(!phases.includes(p))phases.push(p);};
try {
  const lease=await globalThis.__elizaAcquireWorkerLease(JSON.parse(readFileSync(process.env.ELIZA_SMTHRS_PAYLOAD_PATH,'utf8')));
  phase='finish';
  await lease.finishCanonicalResult();
  save({ok:true,phase:'finished',phases});
} catch(error) {
  // Fixed classifications only: never persist helper stderr, env, paths, or stacks.
  const known=new Set(${JSON.stringify(diagnosticCodes)});
  const code=error?.cause?.code??error?.code;
  save({ok:false,phase,phases,code:known.has(code)?code:'UNCLASSIFIED'});
  process.exitCode=1;
} finally {
  input?.close();
  if(input)process.stdin.pause();
}
`,
        { mode: 0o600 }
      );
      const command = workflowRuntimeFileCommand(programPath);
      // Keep this list aligned with runSmithersWorkflow's production worker spawn.
      // Deliberately do not add Windows temp/profile variables to the restricted case.
      const restrictedEnvironment = {
        ...command.env,
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        NODE_ENV: process.env.NODE_ENV,
        SystemRoot: process.env.SystemRoot,
        ELIZA_SMTHRS_STARTUP_DIAGNOSTICS: '1',
        ELIZA_SMTHRS_DB_PATH: join(root, 'runs.sqlite'),
        ELIZA_SMTHRS_PAYLOAD_PATH: payloadPath,
        MSGPACKR_NATIVE_ACCELERATION_DISABLED: 'true',
      };
      const environmentAdditions = { inherited: process.env, restricted: {} };
      const child = spawn(command.executable, command.args, {
        cwd: command.cwd,
        env: { ...environmentAdditions[environment], ...restrictedEnvironment },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      // Drain without exposing private native diagnostics. Results use only fixed codes.
      child.stdout?.resume();
      child.stderr?.resume();
      child.stdin?.on('error', () => {});
      let spawnFailed = false;
      child.once('error', () => {
        spawnFailed = true;
      });
      const exited = new Promise<number | null>((resolve) => child.once('close', resolve));
      async function boundedExit(milliseconds: number) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            exited.then((code) => ({ closed: true as const, code })),
            new Promise<{ closed: false }>((resolve) => {
              timer = setTimeout(() => resolve({ closed: false }), milliseconds);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      }
      let passed = false;
      try {
        const exit = await boundedExit(45000);
        expect(exit.closed, `${environment}/${topology}: worker exit deadline`).toBe(true);
        expect(spawnFailed, 'Owned worker spawn failed').toBe(false);
        const result = JSON.parse(readFileSync(resultPath, 'utf8'));
        console.info(
          JSON.stringify({
            environment,
            helper,
            topology,
            phases: diagnosticPhases.filter(
              (phase) => Array.isArray(result.phases) && result.phases.includes(phase)
            ),
            code: diagnosticCodes.includes(result.code) ? result.code : 'UNCLASSIFIED',
          })
        );
        expect(
          { ok: result.ok, phase: result.phase },
          `${environment}/${helper}: classified helper outcome`
        ).toEqual({
          ok: true,
          phase: 'finished',
        });
        expect(exit.closed && exit.code).toBe(0);
        if (environment === 'inherited' && helper === 'instrumented')
          expect(result.phases).toEqual(diagnosticPhases);
        // The independent parent authenticates absence after canonical helper settlement.
        expect(await windowsWorkflowBackend.inspectWorkerLease(identity)).toEqual({
          state: 'absent',
        });
        passed = true;
      } finally {
        child.stdin?.end();
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        const cleanup = await boundedExit(5000);
        if (passed && cleanup.closed) rmSync(root, { recursive: true, force: true });
        // Unresolved fixture data stays intact. Never kill by name or erase its lease.
        expect(cleanup.closed, 'Owned worker cleanup unconfirmed; fixture retained').toBe(true);
      }
    }, 90000);
  }
}

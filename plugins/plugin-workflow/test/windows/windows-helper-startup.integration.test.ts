import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workflowRuntimeFileCommand } from '../../src/services/workflow-process-host';
import { workerLeasePrelude } from '../../src/services/workflow-worker-lease-prelude';
import { windowsWorkflowBackend } from '../../src/services/workflow-worker-lease.windows';

if (process.platform !== 'win32') throw Error('Real Windows host required');

const tempEnvironment = { TEMP: process.env.TEMP, TMP: process.env.TMP };
const osEnvironment = {
  windir: process.env.windir,
  ComSpec: process.env.ComSpec,
  SystemDrive: process.env.SystemDrive,
};
const profileEnvironment = {
  USERPROFILE: process.env.USERPROFILE,
  APPDATA: process.env.APPDATA,
  LOCALAPPDATA: process.env.LOCALAPPDATA,
  HOMEDRIVE: process.env.HOMEDRIVE,
  HOMEPATH: process.env.HOMEPATH,
  ALLUSERSPROFILE: process.env.ALLUSERSPROFILE,
  ProgramData: process.env.ProgramData,
  PSModulePath: process.env.PSModulePath,
};
const nativeEnvironment = { ...tempEnvironment, ...osEnvironment, ...profileEnvironment };
// Only this fixed allowlist's presence is observable; never enumerate the host environment.
console.info(
  JSON.stringify({
    nativeEnvironmentPresence: Object.fromEntries(
      Object.entries(nativeEnvironment).map(([name, value]) => [
        name,
        typeof value === 'string' && value.length > 0,
      ])
    ),
  })
);

// Actual subprocess discrimination, not a mocked backend. The helper's production
// 15-second startup deadline is unchanged. No workflow or external effect runs.
for (const environment of [
  'inherited',
  'restricted',
  'restricted-temp',
  'restricted-os',
  'restricted-profile',
  'restricted-native',
] as const) {
  for (const topology of ['ignored', 'readline'] as const) {
    test(`bundled Windows helper: ${environment} environment, ${topology} stdin`, async () => {
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
        `${workerLeasePrelude}
import {readFileSync,writeFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
const input=${topology === 'readline' ? 'createInterface({input:process.stdin,crlfDelay:Infinity})' : 'undefined'};
if(input)input.on('line',()=>{});
const save=(value)=>writeFileSync(${JSON.stringify(resultPath)},JSON.stringify(value),{mode:0o600});
let phase='acquire';
try {
  const lease=await globalThis.__elizaAcquireWorkerLease(JSON.parse(readFileSync(process.env.ELIZA_SMTHRS_PAYLOAD_PATH,'utf8')));
  phase='finish';
  await lease.finishCanonicalResult();
  save({ok:true,phase:'finished'});
} catch(error) {
  // Fixed classifications only: never persist helper stderr, env, paths, or stacks.
  const known=new Set(['WINDOWS_LEASE_STARTUP_DEADLINE','WINDOWS_LEASE_COMPILE','WINDOWS_LEASE_TRANSPORT','WINDOWS_LEASE_HELPER_FAILED','WINDOWS_LEASE_BOOTSTRAP','WINDOWS_LEASE_PRIVATE_ACL','WINDOWS_LEASE_STATE_OWNER','WINDOWS_LEASE_STATE_ACL','WINDOWS_LEASE_DIRECTORY','WINDOWS_LEASE_RESERVATION','WINDOWS_LEASE_WORKER','WINDOWS_LEASE_PATH_KIND','WINDOWS_LEASE_PATH_CANONICAL','WINDOWS_LEASE_PATH_REPARSE','WINDOWS_LEASE_INVALID_RESPONSE','WINDOWS_LEASE_OUTPUT_LIMIT']);
  const code=error?.cause?.code??error?.code;
  save({ok:false,phase,code:known.has(code)?code:'UNCLASSIFIED'});
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
      const environmentAdditions = {
        inherited: process.env,
        restricted: {},
        'restricted-temp': tempEnvironment,
        'restricted-os': osEnvironment,
        'restricted-profile': profileEnvironment,
        'restricted-native': nativeEnvironment,
      };
      const child = spawn(command.executable, command.args, {
        cwd: command.cwd,
        env: { ...environmentAdditions[environment], ...restrictedEnvironment },
        stdio: [topology === 'ignored' ? 'ignore' : 'pipe', 'pipe', 'pipe'],
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
        expect(result, `${environment}/${topology}: classified helper outcome`).toEqual({
          ok: true,
          phase: 'finished',
        });
        expect(exit.closed && exit.code).toBe(0);
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

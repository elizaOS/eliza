import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { win32 } from 'node:path';
import type {
  WorkerLeaseInput,
  WorkerLeaseState,
  WorkflowPlatformBackend,
} from './platform-backend-contract';
import { windowsWorkerLeaseScript } from './windows-worker-lease-resource';

/** Export only fixed classifications; helper stderr can contain private paths or source. */
export function classifyWindowsLeaseHelperError(stderr: string): string {
  if (/error CS\d+|Cannot add type/i.test(stderr)) return 'WINDOWS_LEASE_COMPILE';
  if (stderr.includes('Wrong state SID')) return 'WINDOWS_LEASE_STATE_OWNER';
  if (stderr.includes('Untrusted existing state ACL')) return 'WINDOWS_LEASE_STATE_ACL';
  if (
    /Untrusted owner\/ACL|Unexpected ACL principal or rule|Current SID access absent/.test(stderr)
  )
    return 'WINDOWS_LEASE_PRIVATE_ACL';
  if (
    /Local drive path required|Canonical path required|Non-directory or reparse ancestor/.test(
      stderr
    )
  )
    return 'WINDOWS_LEASE_PATH';
  if (/Pin directory ancestor|State ACL handle|Protect state DACL/.test(stderr))
    return 'WINDOWS_LEASE_DIRECTORY';
  if (/Helper source size|Helper source hash/.test(stderr)) return 'WINDOWS_LEASE_BOOTSTRAP';
  if (stderr.includes('CREATE_NEW private file')) return 'WINDOWS_LEASE_RESERVATION';
  if (/Worker identity|Process identity|Process times/.test(stderr)) return 'WINDOWS_LEASE_WORKER';
  return 'WINDOWS_LEASE_HELPER_FAILED';
}

function launch(request: unknown) {
  if (process.platform !== 'win32') throw Error('Windows backend on non-Windows host');
  const root = process.env.SystemRoot;
  if (!root || !win32.isAbsolute(root)) throw Error('Trusted Windows installation unavailable');
  const expected = createHash('sha256').update(windowsWorkerLeaseScript).digest('hex');
  const bootstrap = `$ErrorActionPreference='Stop';$line=[Console]::ReadLine();if($null -eq $line -or $line.Length -gt 2097152){throw 'Helper source size'};$bytes=[Convert]::FromBase64String($line);$hash=[Security.Cryptography.SHA256]::Create();try{$actual=([BitConverter]::ToString($hash.ComputeHash($bytes))).Replace('-','').ToLowerInvariant()}finally{$hash.Dispose()};if($actual -ne '${expected}'){throw 'Helper source hash'};& ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString($bytes)))`;
  const child = spawn(
    win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(bootstrap, 'utf16le').toString('base64'),
    ],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
  );
  let buffer = '',
    failure: Error | undefined;
  const waiting: Array<{
    resolve: (v: Record<string, unknown>) => void;
    reject: (e: Error) => void;
  }> = [];
  const queued: Record<string, unknown>[] = [];
  const fail = (e: Error) => {
    failure = e;
    for (const w of waiting.splice(0)) w.reject(e);
  };
  child.on('error', fail);
  child.stdin.on('error', fail);
  let diagnostic = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    // Continue draining after the bound; never publish the captured text.
    if (diagnostic.length < 65536) diagnostic += chunk.slice(0, 65536 - diagnostic.length);
  });
  const exited = new Promise<void>((resolve, reject) => {
    child.once('close', (code) => {
      const closed = Object.assign(
        Error(`Windows lease helper closed (${classifyWindowsLeaseHelperError(diagnostic)})`),
        { code: classifyWindowsLeaseHelperError(diagnostic) }
      );
      diagnostic = '';
      if (code === 0) resolve();
      else reject(closed);
      fail(closed);
    });
  });
  void exited.catch(() => {});
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 16384) {
      fail(Error('Helper output limit'));
      child.kill();
      return;
    }
    while (buffer.includes('\n')) {
      const n = buffer.indexOf('\n');
      const line = buffer.slice(0, n);
      buffer = buffer.slice(n + 1);
      try {
        const row = JSON.parse(line);
        const w = waiting.shift();
        if (w) w.resolve(row);
        else queued.push(row);
      } catch {
        fail(Error('Invalid helper response'));
        child.kill();
      }
    }
  });
  child.stdin.write(
    Buffer.from(windowsWorkerLeaseScript).toString('base64') + '\n' + JSON.stringify(request) + '\n'
  );
  async function next() {
    if (failure) throw failure;
    if (queued.length) return queued.shift()!;
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        fail(Error('Helper startup deadline'));
        child.kill();
      }, 15000);
      waiting.push({
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }
  async function finish(command?: string) {
    if (command) child.stdin.end(command + '\n');
    else child.stdin.end();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        exited,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            child.kill();
            reject(Error('Helper drain deadline'));
          }, 5000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  return { child, next, finish };
}
export const windowsWorkflowBackend: WorkflowPlatformBackend = {
  platform: 'win32',
  async publishWorkflowSource(path, source) {
    const h = launch({ op: 'publish', path, source: Buffer.from(source).toString('base64') });
    try {
      if ((await h.next()).ok !== true) throw Error('Publication unconfirmed');
    } finally {
      await h.finish();
    }
  },
  async inspectWorkerLease(identity: WorkerLeaseInput): Promise<WorkerLeaseState> {
    const h = launch({ op: 'inspect', identity });
    try {
      const r = await h.next();
      if (r.state === 'absent') return { state: 'absent' };
      if (r.state === 'live' && typeof r.generation === 'string' && typeof r.pid === 'number')
        return { state: 'live', generation: r.generation, pid: r.pid };
      return { state: 'unknown', reason: 'Windows worker reservation unresolved' };
    } catch {
      return { state: 'unknown', reason: 'Windows worker helper unavailable' };
    } finally {
      await h.finish().catch(() => {});
    }
  },
  async acquireWorkerLease(identity) {
    const h = launch({ op: 'acquire', identity, workerPid: process.pid });
    let row: Record<string, unknown>;
    try {
      row = await h.next();
      if (row.ready !== true || typeof row.generation !== 'string')
        throw Error('Lease not admitted');
    } catch (e) {
      await h.finish('abandon').catch(() => {});
      throw Object.assign(
        new Error('Windows worker admission unresolved; preserve reservation and do not replay', {
          cause: e,
        }),
        { code: 'WORKFLOW_WORKER_UNRESOLVED' }
      );
    }
    let done = false;
    return {
      generation: row.generation as string,
      async finishCanonicalResult() {
        if (done) return;
        done = true;
        h.child.stdin.write('finish\n');
        if ((await h.next()).finished !== true) throw Error('Lease completion unconfirmed');
        await h.finish();
      },
      async abandon() {
        if (done) return;
        done = true;
        await h.finish('abandon');
      },
    };
  },
};

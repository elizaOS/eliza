import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs';
import { connect, createServer, type Socket } from 'node:net';
import * as path from 'node:path';
import { resolveAppAliasedEnvValue as resolveAliasedEnvValue } from '@elizaos/host/protocol';
import { windowsWorkflowBackend } from './workflow-worker-lease.windows';

function syncDirectory(value: string) {
  const fd = fs.openSync(value, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export interface WorkerLeaseInput {
  rootDir: string;
  socketRoot: string;
  runId: string;
  versionId: string;
  sourceSha256: string;
  sourcePath?: string;
}
export type WorkerLeaseState =
  | { state: 'absent' }
  | { state: 'live'; generation: string; pid: number }
  | { state: 'unknown'; reason: string };
function ownedDirectory(value: string) {
  const stat = fs.lstatSync(value);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0 ||
    fs.realpathSync(value) !== value
  )
    throw Error('Untrusted worker lease directory');
  return stat;
}
/** Leave room for slash + the fixed 20-hex-character socket basename + .sock. */
const SOCKET_ROOT_BYTE_LIMIT = 100 - 1 - 20 - 5;

/** Stable across parent restarts, private to this UID and canonical home. */
export function resolveWorkerSocketRoot(
  home: string,
  platform: NodeJS.Platform | 'android' = resolveAliasedEnvValue('ELIZA_PLATFORM') === 'android' ||
  process.env.ELIZA_MOBILE_PLATFORM === 'android'
    ? 'android'
    : process.platform
): string {
  const canonicalHome = fs.realpathSync(home);
  let selected = path.join(canonicalHome, '.eliza-worker-ipc');
  if (Buffer.byteLength(selected) > SOCKET_ROOT_BYTE_LIMIT) {
    selected = path.join(canonicalHome, '.ew');
  }
  if (Buffer.byteLength(selected) > SOCKET_ROOT_BYTE_LIMIT) {
    // Android must never move its lease outside its application sandbox.
    if (platform !== 'darwin' && platform !== 'linux') {
      throw Error('Application-private worker socket root is too long');
    }
    const temporary = fs.realpathSync('/tmp');
    const stat = fs.lstatSync(temporary);
    if (
      !stat.isDirectory() ||
      !(
        (stat.uid === 0 && (stat.mode & 0o1000) !== 0) ||
        (stat.uid === process.getuid?.() && (stat.mode & 0o022) === 0)
      )
    ) {
      throw Error('Untrusted short worker socket base');
    }
    selected = path.join(
      temporary,
      `.ew-${process.getuid?.()}-${digest(canonicalHome).slice(0, 32)}`
    );
  }
  if (Buffer.byteLength(selected) > SOCKET_ROOT_BYTE_LIMIT) {
    throw Error('Worker socket root exceeds address budget');
  }
  try {
    fs.mkdirSync(selected, { mode: 0o700 });
    syncDirectory(path.dirname(selected));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  ownedDirectory(selected);
  return selected;
}

function root(input: WorkerLeaseInput) {
  const canonical = fs.realpathSync(input.rootDir),
    parent = fs.lstatSync(canonical);
  if (!parent.isDirectory() || parent.uid !== process.getuid?.())
    throw Error('Untrusted workflow state root');
  if ((parent.mode & 0o022) !== 0) {
    // Our own root, created under a group-writable umask (002 on
    // user-private-group Linux desktops): drop group/other write instead of
    // failing every run. The lease directories below are still checked as
    // owner-only, so nothing another user placed there is trusted.
    fs.chmodSync(canonical, parent.mode & 0o7755);
  }
  const base = path.join(canonical, '.worker-owners');
  try {
    fs.mkdirSync(base, { mode: 0o700 });
    syncDirectory(canonical);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  ownedDirectory(base);
  return path.join(base, digest(input.runId));
}
function readOwner(active: string) {
  ownedDirectory(active);
  const file = path.join(active, 'owner.json'),
    stat = fs.lstatSync(file);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0 ||
    stat.size > 16384
  )
    throw Error('Untrusted worker identity');
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (
    value.uid !== process.getuid?.() ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    typeof value.generation !== 'string' ||
    !/^\w{64}$/.test(value.capability) ||
    typeof value.endpoint !== 'string'
  )
    throw Error('Invalid worker identity');
  return value;
}
/** An authenticated lease proves this generation responds; never infer death from timeout/PID/name. */
export async function inspectWorkerLease(input: WorkerLeaseInput): Promise<WorkerLeaseState> {
  if (process.platform === 'win32') return windowsWorkflowBackend.inspectWorkerLease(input);
  const active = root(input);
  if (!fs.existsSync(active)) return { state: 'absent' };
  try {
    const owner = readOwner(active);
    if (
      owner.runId !== input.runId ||
      owner.versionId !== input.versionId ||
      owner.sourceSha256 !== input.sourceSha256
    )
      return { state: 'unknown', reason: 'Worker provenance differs' };
    const socketRoot = fs.realpathSync(input.socketRoot);
    ownedDirectory(socketRoot);
    if (path.dirname(owner.endpoint) !== socketRoot)
      throw Error('Worker endpoint escaped private root');
    const st = fs.lstatSync(owner.endpoint);
    if (!st.isSocket() || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0)
      throw Error('Worker endpoint is untrusted');
    return await new Promise<WorkerLeaseState>((resolve) => {
      const socket = connect(owner.endpoint);
      let buffer = '';
      const challenge = randomUUID();
      let settled = false;
      const done = (state: WorkerLeaseState) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(state);
      };
      const timer = setTimeout(
        () => done({ state: 'unknown', reason: 'Worker lease did not respond' }),
        1000
      );
      socket.on('error', () =>
        done({
          state: 'unknown',
          reason: 'Worker lease unavailable; outcome unknown',
        })
      );
      socket.on('close', () => done({ state: 'unknown', reason: 'Worker lease closed' }));
      socket.on('connect', () =>
        socket.write(`${JSON.stringify({ capability: owner.capability, challenge })}\n`)
      );
      socket.on('data', (chunk) => {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > 4096)
          return done({
            state: 'unknown',
            reason: 'Worker lease response exceeded limit',
          });
        if (!buffer.endsWith('\n')) return;
        try {
          const reply = JSON.parse(buffer);
          done(
            reply.challenge === challenge && reply.generation === owner.generation
              ? { state: 'live', generation: owner.generation, pid: owner.pid }
              : { state: 'unknown', reason: 'Worker lease identity mismatch' }
          );
        } catch {
          done({ state: 'unknown', reason: 'Malformed worker lease response' });
        }
      });
    });
  } catch (error) {
    return {
      state: 'unknown',
      reason: error instanceof Error ? error.message : 'Unreadable worker lease',
    };
  }
}
/** Native recovery only admits Linux journals with a complete immutable process snapshot. */
function linuxWorkerIdentity() {
  const proc = `/proc/${process.pid}`;
  const stat = fs.readFileSync(`${proc}/stat`, 'utf8');
  const end = stat.lastIndexOf(')');
  const startTicks = stat
    .slice(end + 2)
    .trim()
    .split(/\s+/)[19];
  if (end < 0 || !startTicks || !/^\d+$/.test(startTicks))
    throw Error('Invalid worker process start');
  const executable = fs.realpathSync(`${proc}/exe`);
  const handle = fs.openSync(`${proc}/exe`, 'r');
  try {
    const identity = fs.fstatSync(handle, { bigint: true });
    if (!identity.isFile() || identity.size > 128n * 1024n * 1024n)
      throw Error('Invalid worker executable');
    const hash = createHash('sha256'),
      buffer = Buffer.alloc(65536);
    for (;;) {
      const count = fs.readSync(handle, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
    }
    return {
      pid: process.pid,
      uid: process.getuid?.(),
      startTicks,
      executable,
      device: String(identity.dev),
      inode: String(identity.ino),
      sha256: hash.digest('hex'),
    };
  } finally {
    fs.closeSync(handle);
  }
}

/** Worker calls before importing workflow source/effects. A crash leaves durable unknown state. */
export async function acquireWorkerLease(input: WorkerLeaseInput) {
  if (process.platform === 'win32') return windowsWorkflowBackend.acquireWorkerLease(input);
  const nativeIdentity =
    process.platform === 'linux' && input.sourcePath ? linuxWorkerIdentity() : undefined;
  const sourcePath = input.sourcePath ? fs.realpathSync(input.sourcePath) : undefined;
  if (
    sourcePath &&
    createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex') !== input.sourceSha256
  ) {
    throw Error('Worker source identity mismatch');
  }
  const active = root(input);
  try {
    fs.mkdirSync(active, { mode: 0o700 });
    syncDirectory(path.dirname(active));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw Object.assign(
        Error('Workflow has an existing worker or unknown outcome; no duplicate executor started'),
        { code: 'WORKFLOW_WORKER_UNRESOLVED' }
      );
    throw error;
  }
  const identity = ownedDirectory(active),
    generation = randomUUID(),
    capability = randomBytes(32).toString('hex');
  const socketRoot = fs.realpathSync(input.socketRoot);
  ownedDirectory(socketRoot);
  const endpoint = path.join(socketRoot, `${randomBytes(10).toString('hex')}.sock`);
  if (Buffer.byteLength(endpoint) > 100) throw Error('Worker socket path too long');
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    if (sockets.size >= 4) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    let data = '';
    const timer = setTimeout(() => socket.destroy(), 1000);
    socket.on('error', () => {});
    socket.once('close', () => {
      clearTimeout(timer);
      sockets.delete(socket);
    });
    socket.on('data', (chunk) => {
      data += chunk;
      if (Buffer.byteLength(data) > 4096) {
        socket.destroy();
        return;
      }
      if (!data.endsWith('\n')) return;
      try {
        const request = JSON.parse(data);
        const offered = Buffer.from(String(request.capability));
        if (
          offered.length !== 64 ||
          !timingSafeEqual(offered, Buffer.from(capability)) ||
          typeof request.challenge !== 'string' ||
          request.challenge.length > 64
        ) {
          socket.destroy();
          return;
        }
        socket.end(`${JSON.stringify({ generation, challenge: request.challenge })}\n`);
      } catch {
        socket.destroy();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, resolve);
  });
  fs.chmodSync(endpoint, 0o600);
  const endpointIdentity = fs.lstatSync(endpoint);
  const owner = {
    schemaVersion: nativeIdentity ? 2 : 1,
    ...(nativeIdentity ? { nativeIdentity, sourcePath } : {}),
    generation,
    uid: process.getuid?.(),
    pid: process.pid,
    executable: fs.realpathSync(process.execPath),
    runId: input.runId,
    versionId: input.versionId,
    sourceSha256: input.sourceSha256,
    endpoint,
    capability,
  };
  const fd = fs.openSync(path.join(active, 'owner.json'), 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(owner));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  syncDirectory(active);
  syncDirectory(path.dirname(active));
  let finished = false;
  return {
    generation,
    async finishCanonicalResult() {
      if (finished) return;
      finished = true;
      const current = ownedDirectory(active);
      if (
        current.dev !== identity.dev ||
        current.ino !== identity.ino ||
        readOwner(active).generation !== generation
      )
        throw Error('Worker owner replaced; preserve it');
      // Only invoked after runWorkflow returned its canonical committed result. No output/attempt receipt is replaced.
      const settled = `${active}.settled-${generation}`;
      fs.renameSync(active, settled);
      syncDirectory(path.dirname(active));
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
      if (fs.existsSync(endpoint)) {
        const now = fs.lstatSync(endpoint);
        if (now.dev !== endpointIdentity.dev || now.ino !== endpointIdentity.ino)
          throw Error('Worker endpoint replaced');
        fs.unlinkSync(endpoint);
      }
    },
    async abandon() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) =>
        server.close(() => resolve())
      ); /* Preserve active journal: failed/dead outcome cannot authorize replay. */
    },
  };
}

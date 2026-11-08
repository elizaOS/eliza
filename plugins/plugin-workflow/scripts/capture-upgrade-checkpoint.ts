/**
 * Captures a persisted workflow run for compiler-upgrade-e2e.test.ts.
 *
 *   bun --conditions=eliza-source scripts/capture-upgrade-checkpoint.ts <name>
 *
 * Runs device-bridge-e2e.test.ts until its run waits for the Calendar read
 * after an applied Notes read, then kills that process group without
 * service.stop(). The host database (PGlite dumpDataDir, a gzipped tar) and
 * the Smithers run store (runs.sqlite) are written to
 * __tests__/fixtures/upgrade-checkpoint/<name>, with the persisted Smithers
 * durability version and compiler revision recorded.
 *
 * When the persisted protocol changes, keep the old fixture and capture a new
 * one under a new name; never overwrite a fixture. The upgrade test loads
 * every fixture with the current runtime, so old fixtures are what make it an
 * upgrade test.
 *
 * The desktop worker lease cannot prove its killed worker is gone on another
 * machine (it holds this host's pid, uid and socket), so it is not kept: the
 * fixture is the run as a restarted host finds it once that lease is released.
 */
import { Database } from 'bun:sqlite';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PHONE_COMPILER_REVISION } from '../src/services/phone-workflow-spec';

const CAPTURED_SMITHERS_DIRECTORY = '/captured/smithers';
const CAPTURED_REPO_ROOT = '/captured/repo';
const name = process.argv[2];
if (!name || !/^[\w.-]+$/.test(name))
  throw new Error('usage: bun --conditions=eliza-source scripts/capture-upgrade-checkpoint.ts <name>');
const pluginRoot = resolve(import.meta.dir, '..');
const repoRoot = resolve(pluginRoot, '../..');
const target = join(pluginRoot, '__tests__/fixtures/upgrade-checkpoint', name);
if (existsSync(target)) throw new Error(`${target} exists; capture under a new name`);

const work = await mkdtemp(join(tmpdir(), 'workflow-checkpoint-'));
const checkpoint = join(work, 'state.json');
const child = spawn(
  process.execPath,
  ['--conditions=eliza-source', 'test', '__tests__/integration/device-bridge-e2e.test.ts'],
  {
    cwd: pluginRoot,
    detached: true,
    env: { ...process.env, ELIZA_WORKFLOW_CHECKPOINT_PATH: checkpoint },
    stdio: ['ignore', 'inherit', 'inherit'],
  }
);
const exited = new Promise<void>((done) => child.once('exit', () => done()));
let state: any;
try {
  for (let i = 0; i < 960 && !state; i++) {
    try {
      state = JSON.parse(await readFile(checkpoint, 'utf8'));
    } catch {
      if (child.exitCode !== null) throw new Error('device-bridge-e2e exited before checkpoint');
      await Bun.sleep(250);
    }
  }
  if (!state) throw new Error('device-bridge-e2e did not reach the checkpoint');
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    process.kill(-child.pid!, 'SIGKILL');
    await exited;
  }
}

try {
  await mkdir(target, { recursive: true });
  const db = await PGlite.create(state.directory);
  const dump = await db.dumpDataDir('gzip');
  await db.close();
  await writeFile(join(target, 'pglite-datadir.gz'), Buffer.from(await dump.arrayBuffer()));

  // VACUUM INTO folds the WAL the killed worker left into one small file.
  const runs = new Database(join(state.smithersDirectory, 'runs.sqlite'));
  const durability = JSON.parse(
    (runs.query('SELECT config_json FROM _smithers_runs WHERE run_id=?').get(state.runId) as any)
      .config_json
  ).__smithersDurability;
  runs.run('VACUUM INTO ?', [join(work, 'runs.sqlite')]);
  runs.close();
  // Keep this machine's paths out of the fixture; the test rewrites these to its own.
  const copy = new Database(join(work, 'runs.sqlite'));
  for (const { name: table } of copy
    .query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND sql NOT LIKE 'CREATE VIRTUAL%'"
    )
    .all() as { name: string }[])
    for (const { name: column, type } of copy.query(`PRAGMA table_info("${table}")`).all() as {
      name: string;
      type: string;
    }[])
      if (/text/i.test(type))
        for (const [from, to] of [
          [state.smithersDirectory, CAPTURED_SMITHERS_DIRECTORY],
          [repoRoot, CAPTURED_REPO_ROOT],
        ])
          copy.run(`UPDATE "${table}" SET "${column}"=replace("${column}",?,?)`, [from, to]);
  copy.run('VACUUM');
  copy.close();
  await writeFile(
    join(target, 'runs.sqlite.gz'),
    Bun.gzipSync(await readFile(join(work, 'runs.sqlite')))
  );

  const smithers = createRequire(join(pluginRoot, 'package.json')).resolve('smthrs/package.json');
  const { directory: _directory, ...kept } = state;
  await writeFile(
    join(target, 'state.json'),
    `${JSON.stringify(
      {
        ...kept,
        // Placeholder paths inside runs.sqlite; the test rewrites them to its own.
        smithersDirectory: CAPTURED_SMITHERS_DIRECTORY,
        repoRoot: CAPTURED_REPO_ROOT,
        capturedWith: {
          smithersDurability: durability,
          smithers: JSON.parse(readFileSync(smithers, 'utf8')).version,
          compilerRevision: PHONE_COMPILER_REVISION,
        },
      },
      null,
      2
    )}\n`
  );
  console.log(`Captured ${target}`);
} catch (error) {
  await rm(target, { recursive: true, force: true });
  throw error;
} finally {
  await rm(state.directory, { recursive: true, force: true });
  await rm(state.smithersDirectory, { recursive: true, force: true });
  await rm(work, { recursive: true, force: true });
}

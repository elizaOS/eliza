import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "../../../..");
const bootstrap = join(
  repo,
  "packages/app/src/runtime/install-mobile-workflow-process-host.ts",
);
const host = join(
  repo,
  "plugins/plugin-workflow/src/services/workflow-process-host.ts",
);
const flags = [
  "DISABLE_IO_POOL",
  "FORCE_WAITER_THREAD",
  "DISABLE_RWF_NONBLOCK",
  "DISABLE_SPAWNSYNC_FAST_PATH",
  "DISABLE_ASYNC_TRANSPILER",
].map((name) => `BUN_FEATURE_FLAG_${name}`);
const hash = (file: string) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");
function fixture(
  body: string,
  mutate?: (root: string, env: NodeJS.ProcessEnv) => void,
) {
  const temporary = realpathSync(
    mkdtempSync(join(tmpdir(), "mobile-workflow-host-test-")),
  );
  try {
    const root = join(temporary, "worker"),
      state = join(temporary, "state"),
      loader = join(temporary, "loader");
    mkdirSync(state);
    writeFileSync(loader, '#!/bin/sh\nexec "$@"\n', { mode: 0o700 });
    const files: Record<string, string> = {};
    for (const [name, content] of Object.entries({
      "node_modules/smthrs/package.json": '{"name":"smthrs"}',
      "node_modules/zod/package.json": '{"name":"zod"}',
      "compiler/node_modules/typescript/lib/typescript.js":
        "module.exports={fixture:true}",
      "compiler/node_modules/smthrs/package.json": '{"name":"smthrs"}',
    })) {
      const file = join(root, name);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
      files[name] = hash(file);
    }
    const manifest = join(root, "manifest.json");
    writeFileSync(
      manifest,
      JSON.stringify({
        version: 1,
        compiler: {
          version: 1,
          compilerModule: "node_modules/typescript/lib/typescript.js",
        },
        files,
      }),
    );
    writeFileSync(
      join(root, "files.sha256"),
      Object.entries({ ...files, "manifest.json": hash(manifest) })
        .map(([name, digest]) => `${digest}\t${name}\n`)
        .join(""),
    );
    const env: NodeJS.ProcessEnv = {
      ELIZA_PLATFORM: "android",
      ELIZA_MOBILE_WORKFLOWS: "1",
      ELIZA_SMTHRS_RUNTIME_DIR: root,
      ELIZA_STATE_DIR: state,
      LD_PATH: loader,
      BUN_PATH: realpathSync(process.execPath),
      LD_LIBRARY_PATH: temporary,
    };
    for (const [index, name] of flags.entries())
      env[name] = index % 2 === 0 ? "1" : "0";
    mutate?.(root, env);
    const script = `import {installMobileWorkflowProcessHost as boot} from ${JSON.stringify(bootstrap)};import {workflowProcessCommand as command,workflowStateRoot as stateRoot} from ${JSON.stringify(host)};import {spawnSync} from 'node:child_process';const env=${JSON.stringify(env)};${body}`;
    return spawnSync(
      process.execPath,
      ["--conditions=eliza-source", "--eval", script],
      {
        cwd: temporary,
        env: {
          PATH: process.env.PATH,
          HOME: temporary,
          TMPDIR: temporary,
          UNRELATED_SECRET: "synthetic-not-for-child",
        },
        encoding: "utf8",
        timeout: 15000,
      },
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

test("mobile bootstrap pins real launcher, durable state, and all five flags without inheriting secrets", () => {
  const result = fixture(
    `boot(env);const original=env.ELIZA_STATE_DIR;env.ELIZA_STATE_DIR='/untrusted-change';env.BUN_FEATURE_FLAG_DISABLE_IO_POOL='0';if(stateRoot()!==original+'/smthrs')throw Error('durable state changed');const c=command('runtime',"process.stdout.write(JSON.stringify({flags:Object.fromEntries(Object.entries(process.env).filter(([name])=>name.startsWith('BUN_FEATURE_FLAG_'))),secret:process.env.UNRELATED_SECRET??null}))");const r=spawnSync(c.executable,c.args,{cwd:c.cwd,env:c.env,encoding:'utf8'});if(r.status!==0)throw Error(r.stderr);process.stdout.write(r.stdout);`,
  );
  expect(result.status, result.stderr).toBe(0);
  const output = JSON.parse(result.stdout);
  expect(output.secret).toBeNull();
  expect(output.flags).toEqual(
    Object.fromEntries(
      flags.map((name, index) => [name, index % 2 === 0 ? "1" : "0"]),
    ),
  );
});

test("desktop and disabled mobile keep the legacy state root without requiring packaged resources", () => {
  for (const env of [
    { ELIZA_PLATFORM: "linux" },
    { ELIZA_PLATFORM: "android", ELIZA_MOBILE_WORKFLOWS: "0" },
  ]) {
    const result = fixture(
      `boot(${JSON.stringify(env)});if(stateRoot()!==process.cwd()+'/.eliza/smthrs')throw Error('default changed');`,
    );
    expect(result.status, result.stderr).toBe(0);
  }
});

test("opted-in mobile refuses missing, modified, unindexed, or aliased resources and invalid flags", () => {
  const changes: Array<(root: string, env: NodeJS.ProcessEnv) => void> = [
    (_root, env) => {
      env.ELIZA_SMTHRS_RUNTIME_DIR = "/nonexistent-workflow-resource";
    },
    (root) => rmSync(join(root, "files.sha256")),
    (root) =>
      writeFileSync(
        join(root, "compiler/node_modules/typescript/lib/typescript.js"),
        "modified",
      ),
    (root) => writeFileSync(join(root, "unexpected.js"), "unindexed"),
    (root) => {
      const file = join(root, "node_modules/zod/package.json");
      rmSync(file);
      symlinkSync(join(root, "node_modules/smthrs/package.json"), file);
    },
    (_root, env) => {
      env.BUN_FEATURE_FLAG_DISABLE_IO_POOL = "yes";
    },
    (_root, env) => {
      env.LD_LIBRARY_PATH = "relative";
    },
  ];
  for (const change of changes) {
    const result = fixture("boot(env);", change);
    expect(result.status, result.stderr).not.toBe(0);
  }
});

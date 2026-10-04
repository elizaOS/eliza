import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { WorkflowProcessHost } from '../../src/services/workflow-process-host';

const modulePath = fileURLToPath(
  new URL('../../src/services/workflow-process-host.ts', import.meta.url)
);
const bun = realpathSync(process.execPath);
const digest = (path: string) => ({
  path,
  sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
});
function fixture(body: string, mutate?: (config: WorkflowProcessHost, root: string) => void) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-process-host-')));
  try {
    mkdirSync(join(root, 'node_modules'));
    const prefix = join(root, 'launcher.ts');
    writeFileSync(
      prefix,
      `import {spawnSync} from 'node:child_process'; const r=spawnSync(${JSON.stringify(bun)},process.argv.slice(2),{stdio:'inherit',env:process.env}); process.exit(r.status??1);`
    );
    const compiler = join(root, 'compiler.js');
    writeFileSync(compiler, 'module.exports={fixture:true};');
    const config: WorkflowProcessHost = {
      runtime: { executable: digest(bun), prefixFiles: [digest(prefix)] },
      compiler: { executable: digest(bun), prefixFiles: [] },
      compilerRuntime: 'bun',
      dependencyRoot: root,
      compilerModule: digest(compiler),
      libraryDirectories: [root],
    };
    mutate?.(config, root);
    const script = `import {configureWorkflowProcessHost,workflowProcessCommand,workflowCompilerModule,workflowCompilerDependencyRoot,workflowRuntimeFileCommand} from ${JSON.stringify(modulePath)}; import {spawnSync} from 'node:child_process'; import {writeFileSync} from 'node:fs'; const config=${JSON.stringify(config)}; ${body}`;
    return spawnSync(bun, ['--eval', script], {
      encoding: 'utf8',
      timeout: 15000,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        UNRELATED_SECRET: 'synthetic-parent-only',
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
describe('trusted workflow process host real subprocesses', () => {
  test('large file programs use a short command and preserve stdin through a pinned host', () => {
    const result = fixture(
      `configureWorkflowProcessHost(config); const path=config.dependencyRoot+'/large worker module.mjs'; writeFileSync(path,'/*'+'x'.repeat(100000)+'*/process.stdout.write(await Bun.stdin.text());'); const c=workflowRuntimeFileCommand(path); if(c.args.join(' ').length>4096)throw Error('Source leaked onto command line'); const r=spawnSync(c.executable,c.args,{cwd:c.cwd,env:c.env,encoding:'utf8',input:'parent protocol bytes'}); if(r.status!==0)throw Error(r.stderr); if(r.stdout!=='parent protocol bytes')throw Error('stdin was consumed by bootstrap'); console.log('ok');`
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('ok');
  });

  test('runtime launches through a pinned prefix and preserves exact argument bytes without a shell', () => {
    const result = fixture(
      `configureWorkflowProcessHost(config); const c=workflowProcessCommand('runtime','process.stdout.write(JSON.stringify({arg:process.argv[1],lib:process.env.LD_LIBRARY_PATH,secret:process.env.UNRELATED_SECRET??null}))',['literal $(touch nope); spaces']); const r=spawnSync(c.executable,c.args,{cwd:c.cwd,env:c.env,encoding:'utf8'}); if(r.status!==0)throw Error(r.stderr); const v=JSON.parse(r.stdout); if(v.arg!=='literal $(touch nope); spaces'||v.lib!==config.dependencyRoot||v.secret!==null)throw Error('wrong child contract'); console.log('ok');`
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('ok');
  });
  test('Bun compiler command retains module argv and stdin transport', () => {
    const result = fixture(
      `configureWorkflowProcessHost(config); const c=workflowProcessCommand('compiler','const v=require(process.argv[1]); process.stdout.write(JSON.stringify({v,input:await Bun.stdin.text()}))',[workflowCompilerModule()]); const r=spawnSync(c.executable,c.args,{cwd:c.cwd,env:c.env,input:'untrusted draft data',encoding:'utf8'}); if(r.status!==0)throw Error(r.stderr); const v=JSON.parse(r.stdout); if(!v.v.fixture||v.input!=='untrusted draft data')throw Error('bad compiler transport');`
    );
    expect(result.status).toBe(0);
  });
  test('rejects a mismatched executable digest before spawning', () => {
    const r = fixture('configureWorkflowProcessHost(config);', (c) => {
      c.runtime.executable.sha256 = '0'.repeat(64);
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('verification failed');
  });
  test('rechecks modified prefix bytes at dispatch', () => {
    const r = fixture(
      "configureWorkflowProcessHost(config); writeFileSync(config.runtime.prefixFiles[0].path,'changed'); workflowProcessCommand('runtime','');"
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('verification failed');
  });
  test('rejects relative directories and repeated host installation', () => {
    expect(
      fixture('configureWorkflowProcessHost(config);', (c) => {
        c.dependencyRoot = '.';
      }).status
    ).not.toBe(0);
    const r = fixture(
      'configureWorkflowProcessHost(config); configureWorkflowProcessHost(config);'
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('already configured');
  });
  test('copies descriptor so caller mutations cannot redirect subsequent launches', () => {
    const r = fixture(
      "configureWorkflowProcessHost(config); config.runtime.executable.path='/invalid'; config.runtime.prefixFiles.length=0; const c=workflowProcessCommand('runtime','console.log(42)'); const r=spawnSync(c.executable,c.args,{cwd:c.cwd,env:c.env,encoding:'utf8'}); if(r.status!==0||r.stdout.trim()!=='42')throw Error('mutated host');"
    );
    expect(r.status).toBe(0);
  });
  test('cannot replace the desktop host after its first dispatch', () => {
    const r = fixture(
      "workflowProcessCommand('runtime',''); configureWorkflowProcessHost(config);"
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('before dispatch');
  });
  test('compiler root stays separate from runtime dependencies and copied configuration', () => {
    const r = fixture(
      "configureWorkflowProcessHost(config); const expected=config.compilerDependencyRoot; config.compilerDependencyRoot='/invalid'; if(workflowCompilerDependencyRoot()!==expected)throw Error('compiler root mutated'); if(workflowProcessCommand('compiler','').cwd!==expected)throw Error('wrong compiler cwd'); if(workflowProcessCommand('runtime','').cwd!==config.dependencyRoot)throw Error('wrong runtime cwd');",
      (config, root) => {
        config.compilerDependencyRoot = join(root, 'compiler-root');
        mkdirSync(join(config.compilerDependencyRoot, 'node_modules'), { recursive: true });
      }
    );
    expect(r.status).toBe(0);
  });
  test('default compiler retains Node 512MiB old-space argument', () => {
    const r = fixture(
      "const c=workflowProcessCommand('compiler','program',['module']); if(c.executable!=='node'||JSON.stringify(c.args)!==JSON.stringify(['--max-old-space-size=512','-e','program','module']))throw Error('default changed');"
    );
    expect(r.status).toBe(0);
  });
});

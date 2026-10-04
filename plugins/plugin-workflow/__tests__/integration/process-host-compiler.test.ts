/** Real semantic compiler child under the configured Bun host; never executes a draft. */
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const pin = (path: string) => {
  const canonical = realpathSync(path);
  return {
    path: canonical,
    sha256: createHash('sha256').update(readFileSync(canonical)).digest('hex'),
  };
};
test('configured Bun compiler retains strict draft type/import/default-export checks without executing source', () => {
  const root = realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
  const host = fileURLToPath(
    new URL('../../src/services/workflow-process-host.ts', import.meta.url)
  );
  const checker = fileURLToPath(
    new URL('../../src/services/workflow-source-check.ts', import.meta.url)
  );
  const launcher = { executable: pin(process.execPath), prefixFiles: [] };
  const config = {
    runtime: launcher,
    compiler: launcher,
    compilerRuntime: 'bun',
    dependencyRoot: root,
    compilerModule: pin(require.resolve('typescript')),
    libraryDirectories: [],
  };
  const valid = `/** @jsxImportSource smthrs */
import {createSmithers} from 'smthrs/create';
import {z} from 'zod';
const {Workflow,Task,smithers,outputs}=createSmithers({answer:z.object({value:z.number()})},{dbPath:process.env.ELIZA_SMTHRS_DB_PATH});
export default smithers(()=><Workflow name="arithmetic"><Task id="answer" output={outputs.answer}>{()=>({value:56})}</Task></Workflow>);`;
  const sources = [
    valid,
    'const broken: number = "wrong";\n' + valid,
    'export default {};',
    'import fs from "node:fs";' + valid,
    '// @ts-nocheck\n' + valid,
    'throw new Error("draft executed");\n' + valid,
  ];
  const script = `import {configureWorkflowProcessHost} from ${JSON.stringify(host)}; import {checkWorkflowSource} from ${JSON.stringify(checker)}; configureWorkflowProcessHost(${JSON.stringify(config)}); const diagnostics=[]; for (const source of ${JSON.stringify(sources)}) diagnostics.push(await checkWorkflowSource(source)); process.stdout.write(JSON.stringify(diagnostics));`;
  const result = spawnSync(process.execPath, ['--conditions=eliza-source', '--eval', script], {
    encoding: 'utf8',
    timeout: 110000,
    maxBuffer: 32768,
  });
  if (result.status !== 0)
    throw new Error(
      `Compiler child failed (${result.status}, ${result.signal}): ${result.stderr || result.stdout}`
    );
  expect(result.status).toBe(0);
  expect(result.stderr).not.toContain('draft executed');
  const diagnostics = JSON.parse(result.stdout) as string[][];
  expect(diagnostics.map((items) => items.length === 0)).toEqual([
    true,
    false,
    false,
    false,
    false,
    true,
  ]);
}, 115000);

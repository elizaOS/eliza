import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildWorkflowArtifact } from "./build-workflow-artifact";

test("produced resources compile and execute a real workflow outside the checkout", async () => {
  const sourceRoot = resolve(import.meta.dir, "../../../.."),
    temporary = realpathSync(
      mkdtempSync(join(tmpdir(), "workflow-artifact-production-")),
    );
  const hash = (file: string) =>
    createHash("sha256").update(readFileSync(file)).digest("hex");
  try {
    const output = join(temporary, "artifact"),
      sourceIdentity = hash(join(sourceRoot, "bun.lock"));
    const produced = await buildWorkflowArtifact({
      sourceRoot,
      outputDir: output,
      sourceIdentity,
    });
    expect(produced.manifest.sourceStampSha256).toBe(sourceIdentity);
    const pin = (file: string) => ({
        path: realpathSync(file),
        sha256: hash(file),
      }),
      launcher = { executable: pin(process.execPath), prefixFiles: [] };
    const descriptor = {
      runtime: launcher,
      compiler: launcher,
      compilerRuntime: "bun",
      dependencyRoot: output,
      compilerDependencyRoot: join(output, "compiler"),
      compilerModule: pin(
        join(output, "compiler/node_modules/typescript/lib/typescript.js"),
      ),
      libraryDirectories: [],
    };
    const source = `/** @jsxImportSource smthrs */
import {createSmithers} from 'smthrs/create';import {z} from 'zod';
const {Workflow,Task,smithers,outputs}=createSmithers({output:z.object({value:z.number()})},{dbPath:process.env.ELIZA_SMTHRS_DB_PATH});
export default smithers(()=><Workflow name="produced"><Task id="synthetic" output={outputs.output}>{()=>({value:56})}</Task></Workflow>);`;
    const workflow = {
      id: "synthetic",
      name: "Produced artifact",
      active: true,
      language: "tsx",
      source,
      steps: [],
      widgets: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      versionId: "v1",
    };
    const script = `import {configureWorkflowProcessHost} from ${JSON.stringify(join(sourceRoot, "plugins/plugin-workflow/src/services/workflow-process-host.ts"))};import {checkWorkflowSource} from ${JSON.stringify(join(sourceRoot, "plugins/plugin-workflow/src/services/workflow-source-check.ts"))};import {runSmithersWorkflow} from ${JSON.stringify(join(sourceRoot, "plugins/plugin-workflow/src/services/smithers-runtime.ts"))};configureWorkflowProcessHost(${JSON.stringify(descriptor)});const source=${JSON.stringify(source)};if((await checkWorkflowSource(source)).length)throw Error('Valid source rejected');if(!(await checkWorkflowSource("import {CodexAgent} from 'smthrs';\\n"+source)).length)throw Error('Unavailable export accepted');const result=await runSmithersWorkflow({tenantId:'artifact-test',workflow:${JSON.stringify(workflow)},runId:'produced',mode:'manual',input:{},timeoutMs:20000,generate:async()=>{throw Error('Unexpected model call');}});if(result.status!=='finished')throw Error('Produced workflow failed: '+JSON.stringify(result));const replay=await runSmithersWorkflow({tenantId:'artifact-test',workflow:${JSON.stringify(workflow)},runId:'produced',mode:'manual',input:{},timeoutMs:20000,generate:async()=>{throw Error('Unexpected replay model call');}});if(JSON.stringify(replay.output)!==JSON.stringify(result.output)||!Array.isArray(replay.output)||replay.output[0]?.value!==56)throw Error('Canonical output lost on replay');console.log('ARTIFACT_FLOW_PASS');`;
    const result = spawnSync(
      process.execPath,
      ["--conditions=eliza-source", "--eval", script],
      {
        cwd: temporary,
        env: { PATH: process.env.PATH, HOME: temporary, TMPDIR: temporary },
        encoding: "utf8",
        timeout: 60000,
        maxBuffer: 1024 * 1024,
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("ARTIFACT_FLOW_PASS");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}, 120000);

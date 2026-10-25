/** Semantic checking only: this does not execute drafts or authorize their effects. */
import { spawn } from 'node:child_process';
import { WorkflowApiError } from '../types/index';

import {
  workflowCompilerDependencyRoot,
  workflowCompilerModule,
  workflowProcessCommand,
} from './workflow-process-host';

const MAX_SOURCE_BYTES = 65536;
const MAX_OUTPUT_BYTES = 16384;
// A cold compiler loads the complete Smithers/Zod declaration graph. Keep a
// bounded budget that also admits cold mobile storage and loaded CI hosts.
const DEADLINE_MS = 60000;

// The child runs only this trusted compiler program. Draft text is input data.
const COMPILER_PROGRAM = String.raw`
const ts = require(process.argv[1]);
const path = require('node:path');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; if (input.length > 450000) process.exit(2); });
process.stdin.on('end', () => {
  const { source, anchor } = JSON.parse(input);
  const file = path.join(anchor, '__eliza_generated_workflow__.tsx');
  const ambient = path.join(anchor, '__eliza_workflow_runtime__.d.ts');
  const contractFile = path.join(anchor, '__eliza_workflow_contract__.ts');
  const contract = 'import workflow from "./__eliza_generated_workflow__"; import type { SmithersWorkflow } from "smthrs"; const checked: SmithersWorkflow<any> = workflow;';
  const injected = 'declare const process: { env: { ELIZA_SMTHRS_DB_PATH: string | undefined } }; declare var __elizaSmithers: { agent: { id: string; generate(args?: import("smthrs").AgentGenerateOptions): Promise<{ text: string }> } };';
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const allowed = new Set(['smthrs', 'smthrs/create', 'smthrs/jsx-runtime', 'zod']);
  const rejected = [];
  if (/@ts-(?:ignore|expect-error|nocheck|check)\b/i.test(source)) rejected.push('TypeScript suppression/directive comments are not supported');
  if (parsed.referencedFiles.length || parsed.typeReferenceDirectives.length || parsed.libReferenceDirectives.length || parsed.hasNoDefaultLib) rejected.push('Source reference directives are not supported');
  const visit = node => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (!ts.isStringLiteral(node.moduleSpecifier) || !allowed.has(node.moduleSpecifier.text)) rejected.push('Unsupported source import');
    }
    if (ts.isImportEqualsDeclaration(node) || ts.isImportTypeNode(node) || (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require')))) rejected.push('Dynamic and type-only module loaders are not supported');
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  if (rejected.length) { process.stdout.write(JSON.stringify({ok:false, diagnostics:[...new Set(rejected)]})); return; }
  const options = { target:ts.ScriptTarget.ES2022, module:ts.ModuleKind.ESNext, moduleResolution:ts.ModuleResolutionKind.Bundler, jsx:ts.JsxEmit.ReactJSX, jsxImportSource:'smthrs', strict:true, noEmit:true, skipLibCheck:true, types:[], typeRoots:[path.join(anchor,'node_modules/@types')], lib:['lib.es2022.d.ts'], allowImportingTsExtensions:true };
  const host = ts.createCompilerHost(options);
  const originalGet = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, onError, shouldCreate) => name === file ? parsed : name === ambient ? ts.createSourceFile(ambient, injected, languageVersion, true) : name === contractFile ? ts.createSourceFile(contractFile, contract, languageVersion, true) : originalGet(name, languageVersion, onError, shouldCreate);
  host.resolveModuleNames = (names, containing) => names.map(name => {
    if (containing === contractFile && name === './__eliza_generated_workflow__') return { resolvedFileName:file, extension:ts.Extension.Tsx };
    if (containing === file && !allowed.has(name)) return undefined;
    return ts.resolveModuleName(name, containing, options, host).resolvedModule;
  });
  const program = ts.createProgram([file, ambient, contractFile], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program).filter(d => d.category === ts.DiagnosticCategory.Error);
  process.stdout.write(JSON.stringify({ok:diagnostics.length === 0, diagnostics:diagnostics.slice(0,10).map(d => {
    const location = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start) : undefined;
    return 'TS'+d.code+(location ? ' line '+(location.line+1) : '')+': '+ts.flattenDiagnosticMessageText(d.messageText,' ').slice(0,500);
  })}));
});
`;

export async function checkWorkflowSource(source: string): Promise<string[]> {
  if (Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES)
    return ['Workflow source exceeds 65536 bytes'];
  let compiler: string;
  try {
    compiler = workflowCompilerModule();
  } catch {
    throw new WorkflowApiError('Workflow compiler unavailable', 503);
  }
  const anchor = workflowCompilerDependencyRoot();
  return new Promise((resolve, reject) => {
    const command = workflowProcessCommand('compiler', COMPILER_PROGRAM, [compiler]);
    const child = spawn(command.executable, command.args, {
      cwd: command.cwd,
      env: { ...command.env, PATH: process.env.PATH ?? '', NODE_NO_WARNINGS: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    let bytes = 0;
    let failed = false;
    const stop = (message: string) => {
      if (failed) return;
      failed = true;
      child.kill('SIGKILL');
      reject(new WorkflowApiError(message, 503));
    };
    const timer = setTimeout(() => stop('Workflow compiler deadline exceeded'), DEADLINE_MS);
    child.on('error', () => stop('Workflow compiler unavailable'));
    child.stdin.on('error', () => stop('Workflow compiler input failed'));
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) stop('Workflow compiler output limit exceeded');
      else output += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) stop('Workflow compiler output limit exceeded');
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (failed) return;
      if (code !== 0) {
        reject(new WorkflowApiError('Workflow compiler failed', 503));
        return;
      }
      try {
        const result = JSON.parse(output) as {
          ok: boolean;
          diagnostics: string[];
        };
        if (
          typeof result.ok !== 'boolean' ||
          !Array.isArray(result.diagnostics) ||
          !result.diagnostics.every((value) => typeof value === 'string' && value.length > 0) ||
          (!result.ok && result.diagnostics.length === 0)
        )
          throw new WorkflowApiError('Invalid compiler result', 503);
        resolve(result.ok ? [] : result.diagnostics);
      } catch {
        reject(new WorkflowApiError('Workflow compiler returned invalid diagnostics', 503));
      }
    });
    child.stdin.end(JSON.stringify({ source, anchor }));
  });
}

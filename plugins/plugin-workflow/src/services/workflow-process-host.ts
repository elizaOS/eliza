/** Trusted host bootstrap only. Never populate this descriptor from workflow or HTTP input. */
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface WorkflowHostFile {
  path: string;
  sha256: string;
}
export interface WorkflowHostLauncher {
  executable: WorkflowHostFile;
  /** Executable prefix files, e.g. the Bun ELF passed to a musl loader. No shell or flags. */
  prefixFiles: readonly WorkflowHostFile[];
}
export interface WorkflowProcessHost {
  runtime: WorkflowHostLauncher;
  compiler: WorkflowHostLauncher;
  /** Already extracted, immutable dependency artifact, containing node_modules. */
  dependencyRoot: string;
  /** Optional separate immutable compiler/declaration artifact. Defaults to dependencyRoot. */
  compilerDependencyRoot?: string;
  compilerModule: WorkflowHostFile;
  /** Only native library search paths may be added to the existing child environment. */
  libraryDirectories: readonly string[];
  compilerRuntime: 'bun' | 'node';
}
export class WorkflowProcessHostError extends Error {
  readonly code = 'WORKFLOW_PROCESS_HOST_INVALID';
}
let configured: Readonly<WorkflowProcessHost> | undefined;
let dispatched = false;
const defaultRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
function directory(path: string): string {
  if (
    path.includes(':') ||
    !isAbsolute(path) ||
    realpathSync(path) !== path ||
    !statSync(path).isDirectory()
  ) {
    throw new WorkflowProcessHostError('Workflow host requires a canonical absolute directory');
  }
  return path;
}
function file(value: WorkflowHostFile): WorkflowHostFile {
  if (
    !isAbsolute(value.path) ||
    realpathSync(value.path) !== value.path ||
    !statSync(value.path).isFile() ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    createHash('sha256').update(readFileSync(value.path)).digest('hex') !== value.sha256
  ) {
    throw new WorkflowProcessHostError('Workflow host file verification failed');
  }
  return Object.freeze({ path: value.path, sha256: value.sha256 });
}
function launcher(value: WorkflowHostLauncher): WorkflowHostLauncher {
  if (!Array.isArray(value.prefixFiles) || value.prefixFiles.length > 4) {
    throw new WorkflowProcessHostError('Invalid workflow host executable prefix');
  }
  const executable = file(value.executable);
  if (!(statSync(executable.path).mode & 0o111))
    throw new WorkflowProcessHostError('Workflow host executable is not executable');
  return Object.freeze({ executable, prefixFiles: Object.freeze(value.prefixFiles.map(file)) });
}
/** Install once, before starting any workflow services. No environment-variable configuration. */
export function configureWorkflowProcessHost(value: WorkflowProcessHost): void {
  if (dispatched)
    throw new WorkflowProcessHostError('Workflow process host must be configured before dispatch');
  if (configured) throw new WorkflowProcessHostError('Workflow process host already configured');
  if (value.compilerRuntime !== 'bun' && value.compilerRuntime !== 'node')
    throw new WorkflowProcessHostError('Invalid workflow compiler runtime');
  if (!Array.isArray(value.libraryDirectories) || value.libraryDirectories.length > 8)
    throw new WorkflowProcessHostError('Invalid workflow library paths');
  const dependencyRoot = directory(value.dependencyRoot);
  directory(join(dependencyRoot, 'node_modules'));
  const compilerDependencyRoot = directory(value.compilerDependencyRoot ?? dependencyRoot);
  directory(join(compilerDependencyRoot, 'node_modules'));
  configured = Object.freeze({
    runtime: launcher(value.runtime),
    compiler: launcher(value.compiler),
    dependencyRoot,
    compilerDependencyRoot,
    compilerModule: file(value.compilerModule),
    compilerRuntime: value.compilerRuntime,
    libraryDirectories: Object.freeze(value.libraryDirectories.map(directory)),
  });
}
export function workflowDependencyRoot(): string {
  return configured?.dependencyRoot ?? defaultRoot;
}
export function workflowCompilerDependencyRoot(): string {
  return configured?.compilerDependencyRoot ?? workflowDependencyRoot();
}
export function workflowDependencyPackage(name: 'smthrs' | 'zod'): string | undefined {
  if (!configured) return undefined;
  const root = directory(realpathSync(join(configured.dependencyRoot, 'node_modules', name)));
  return root;
}
export function workflowCompilerModule(): string {
  return configured
    ? file(configured.compilerModule).path
    : createRequire(import.meta.url).resolve('typescript');
}
export function defaultWorkflowBunExecutable(): string {
  return process.env.BUN_BIN?.trim() || (process.versions.bun ? process.execPath : 'bun');
}
/** Keep per-operation env/stdio/deadline ownership at each call site. */
export function workflowProcessCommand(
  kind: 'runtime' | 'compiler',
  program: string,
  tail: string[] = []
) {
  dispatched = true;
  const host = configured;
  const selected = host?.[kind];
  if (selected) {
    // Recheck executable bytes before dispatch; never trust a stale bootstrap hash.
    launcher(selected);
    if (host) {
      directory(host.dependencyRoot);
      directory(host.compilerDependencyRoot ?? host.dependencyRoot);
      host.libraryDirectories.forEach(directory);
    }
  }
  const nodeCompiler =
    kind === 'compiler' && (!configured || configured.compilerRuntime === 'node');
  return {
    executable:
      selected?.executable.path ?? (kind === 'compiler' ? 'node' : defaultWorkflowBunExecutable()),
    args: [
      ...(selected?.prefixFiles.map((entry) => entry.path) ?? []),
      ...(selected && !nodeCompiler ? ['--no-install'] : []),
      ...(nodeCompiler ? ['--max-old-space-size=512', '-e'] : ['--eval']),
      program,
      ...tail,
    ],
    cwd: host
      ? kind === 'compiler'
        ? (host.compilerDependencyRoot ?? host.dependencyRoot)
        : host.dependencyRoot
      : kind === 'runtime'
        ? defaultRoot
        : undefined,
    env: configured?.libraryDirectories.length
      ? { LD_LIBRARY_PATH: configured.libraryDirectories.join(':') }
      : {},
  };
}

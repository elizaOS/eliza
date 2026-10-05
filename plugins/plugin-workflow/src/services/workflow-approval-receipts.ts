/** Read-only canonical Smithers approval projection. Never imports workflow source. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { WorkflowApiError, type WorkflowExecution } from '../types/index';
import { resolveSmithersWorkflowDir } from './smithers-runtime';
import { workflowProcessCommand } from './workflow-process-host';
export interface ApprovalReceipt {
  runId: string;
  workflowId: string;
  workflowVersionId: string;
  nodeId: string;
  iteration: number;
  requestDigest: string;
  status: 'pending' | 'approved' | 'denied';
  title: string;
  summary: string;
  operation: string;
  target: string;
  account: string;
  supported: boolean;
  decidedAt?: string;
  decidedBy?: string;
}
const script = `import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';
const smithersRequire=createRequire(import.meta.resolve('smthrs'));
const {Effect}=await import(pathToFileURL(smithersRequire.resolve('effect')).href);
import {openSmithersStore} from 'smthrs/openSmithersStore';
const input=JSON.parse(await Bun.stdin.text());const store=await openSmithersStore({mode:'read',backend:'sqlite',dbPath:input.dbPath});
try{const pending=await Effect.runPromise(store.adapter.listPendingApprovals(input.runId));const decided=await Effect.runPromise(store.adapter.listAllDecidedApprovals(input.runId));process.stdout.write(JSON.stringify([...pending,...decided]));}finally{await store.cleanup();}`;
function bounded(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  if (value.length > max)
    throw new WorkflowApiError('Approval review text exceeds supported bounds', 422);
  return value;
}
export async function readApprovalReceipts(
  tenantId: string,
  execution: WorkflowExecution
): Promise<ApprovalReceipt[]> {
  const dbPath = join(resolveSmithersWorkflowDir(tenantId, execution.workflowId), 'runs.sqlite');
  try {
    await access(dbPath);
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === 'ENOENT' &&
      (execution.status === 'queued' || execution.status === 'running')
    )
      return [];
    throw new WorkflowApiError('Approval store unavailable', 503);
  }
  const raw = await new Promise<string>((resolve, reject) => {
    const command = workflowProcessCommand('runtime', script);
    const child = spawn(command.executable, command.args, {
      cwd: command.cwd,
      env: {
        ...command.env,
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        MSGPACKR_NATIVE_ACCELERATION_DISABLED: 'true',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let text = '',
      failure = false;
    const timer = setTimeout(() => {
      failure = true;
      child.kill('SIGKILL');
    }, 15000);
    child.stdout.on('data', (chunk) => {
      text += chunk;
      if (Buffer.byteLength(text) > 524288) {
        failure = true;
        child.kill('SIGKILL');
      }
    });
    child.stderr.resume();
    child.on('error', () => {
      clearTimeout(timer);
      reject(new WorkflowApiError('Approval store unavailable', 503));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 || failure) reject(new WorkflowApiError('Approval store unavailable', 503));
      else resolve(text);
    });
    child.stdin.on('error', () => {
      failure = true;
    });
    child.stdin.end(JSON.stringify({ dbPath, runId: execution.id }));
  });
  let rows: unknown;
  try {
    rows = JSON.parse(raw);
  } catch {
    throw new WorkflowApiError('Invalid canonical approval response', 503);
  }
  if (!Array.isArray(rows) || rows.length > 100)
    throw new WorkflowApiError('Approval receipt limit exceeded', 422);
  return rows.map((row) => {
    if (
      !row ||
      typeof row !== 'object' ||
      row.runId !== execution.id ||
      typeof row.nodeId !== 'string' ||
      row.nodeId.length > 200 ||
      !Number.isSafeInteger(row.iteration) ||
      row.iteration < 0 ||
      !['requested', 'approved', 'denied'].includes(row.status)
    )
      throw new WorkflowApiError('Invalid canonical approval identity', 503);
    const encoded = bounded(row.requestJson, 64000);
    let request: Record<string, any> = {};
    try {
      request = JSON.parse(encoded);
      if (!request || typeof request !== 'object' || Array.isArray(request))
        throw new Error('Invalid request');
    } catch {
      throw new WorkflowApiError('Invalid canonical approval request', 503);
    }
    const envelope = request.metadata;
    const fields =
      envelope && typeof envelope === 'object' && !Array.isArray(envelope) ? envelope : {};
    // Versioned, host-independent presentation. An explicit unsupported value
    // must not downgrade to the legacy Alpha Phone contract.
    const hasPresentation = Object.hasOwn(fields, 'approvalPresentation');
    const presentation = hasPresentation ? fields.approvalPresentation : fields.alphaPhone;
    const metadata =
      presentation &&
      typeof presentation === 'object' &&
      !Array.isArray(presentation) &&
      (!hasPresentation || presentation.version === 1)
        ? presentation
        : {};
    const title = bounded(request.title, 500),
      summary = bounded(request.summary, 4000),
      operation = bounded(metadata?.operation, 500),
      target = bounded(metadata?.target, 1000),
      account = bounded(metadata?.account, 500);
    const supported =
      !!title &&
      !!summary &&
      !!operation &&
      !!target &&
      !!account &&
      ['gate', 'approve', 'decision'].includes(request.mode) &&
      (!request.options || request.options.length === 0) &&
      (!request.allowedUsers || request.allowedUsers.length === 0) &&
      (!request.allowedScopes || request.allowedScopes.length === 0) &&
      !request.autoApprove;
    return {
      runId: execution.id,
      workflowId: execution.workflowId,
      workflowVersionId: execution.workflowVersionId,
      nodeId: row.nodeId,
      iteration: row.iteration,
      requestDigest: createHash('sha256')
        .update(
          JSON.stringify([
            execution.id,
            execution.workflowVersionId,
            row.nodeId,
            row.iteration,
            encoded,
          ])
        )
        .digest('hex'),
      status: row.status === 'requested' ? 'pending' : row.status,
      title,
      summary,
      operation,
      target,
      account,
      supported,
      ...(Number.isFinite(row.decidedAtMs)
        ? { decidedAt: new Date(row.decidedAtMs).toISOString() }
        : {}),
      ...(typeof row.decidedBy === 'string' ? { decidedBy: bounded(row.decidedBy, 200) } : {}),
    };
  });
}

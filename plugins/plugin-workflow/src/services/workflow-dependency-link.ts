/** Maintains links in the host-owned private workflow directory, never package contents. */
import { randomUUID } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

export class WorkflowDependencyLinkError extends Error {
  readonly code = 'WORKFLOW_DEPENDENCY_LINK_INVALID';
}

export function ensureWorkflowDependencyLink(packageDirectory: string, linkPath: string): void {
  const target = realpathSync(packageDirectory);
  const parent = dirname(linkPath);
  mkdirSync(parent, { recursive: true });
  if (lstatSync(parent).isSymbolicLink()) {
    throw new WorkflowDependencyLinkError('Workflow dependency parent must not be a symbolic link');
  }
  let previous: ReturnType<typeof lstatSync> | undefined;
  try {
    previous = lstatSync(linkPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (!previous) {
    symlinkSync(target, linkPath, 'junction');
    return;
  }
  if (!previous.isSymbolicLink())
    throw new WorkflowDependencyLinkError('Workflow dependency slot is not a symbolic link');
  const current = readlinkSync(linkPath);
  if (resolve(parent, current) === target) return;
  // These slots are service-owned. Legacy links were absolute junctions; do not
  // replace an unfamiliar relative link or delete any directory/file contents.
  if (!isAbsolute(current))
    throw new WorkflowDependencyLinkError('Unrecognized workflow dependency link');
  const temporary = `${linkPath}.replacement-${randomUUID()}`;
  try {
    symlinkSync(target, temporary, 'junction');
    const latest = lstatSync(linkPath);
    if (
      !latest.isSymbolicLink() ||
      latest.dev !== previous.dev ||
      latest.ino !== previous.ino ||
      readlinkSync(linkPath) !== current
    ) {
      throw new WorkflowDependencyLinkError('Workflow dependency link changed during replacement');
    }
    renameSync(temporary, linkPath);
  } finally {
    removeTemporaryLink(temporary);
  }
}

function removeTemporaryLink(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

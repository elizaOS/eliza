import { existsSync } from 'node:fs';
import { rimraf } from 'rimraf';
import { ResetActionRecord } from '../types';

/**
 * Delete a directory with error handling
 * @param dir Directory path to delete
 * @param actions Action log collection to update
 * @param label Description label for this operation
 * @returns Success or failure
 */
export async function safeDeleteDirectory(
  dir: string,
  actions: ResetActionRecord,
  label: string
): Promise<boolean> {
  if (!existsSync(dir)) {
    actions.skipped.push(`${label} (not found)`);
    return false;
  }

  try {
    await rimraf(dir);
    if (!existsSync(dir)) {
      actions.deleted.push(label);
      return true;
    } else {
      actions.warning.push(`Failed to delete ${label.toLowerCase()}`);
      return false;
    }
  } catch (error) {
    actions.warning.push(`Failed to delete ${label.toLowerCase()}`);
    return false;
  }
}

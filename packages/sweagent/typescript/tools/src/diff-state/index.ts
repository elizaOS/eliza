/**
 * Diff state tool
 * Tracks git diff state in a JSON file
 * Converted from tools/diff_state/
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { program } from 'commander';
import { registry } from '../registry';

const rootDir = process.env.ROOT || process.env.TMPDIR || '/tmp';
const STATE_PATH = path.join(rootDir, 'state.json');
const PATCH_PATH = path.join(rootDir, 'model.patch');

interface State {
  diff?: string;
  [key: string]: any;
}

function loadState(): State {
  if (fs.existsSync(STATE_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
    } catch {
      return {};
    }
  }
  return {};
}

function saveState(state: State): void {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function updateDiffState(): void {
  const state = loadState();
  const repoRoot = String(registry.get('ROOT', process.env.ROOT || '.'));
  
  try {
    // Stage all changes and get the diff
    execSync('git add -A', { cwd: repoRoot as string, stdio: 'ignore' });
    const patch = execSync(`git diff --cached`, { 
      cwd: repoRoot as string,
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024 // 10MB buffer
    });
    
    // Save patch to file
    fs.writeFileSync(PATCH_PATH, patch);
    
    // Update state
    state.diff = patch.trim();
    saveState(state);
    
    console.log('Diff state updated successfully');
  } catch (error) {
    console.error('Error updating diff state:', error);
    clearDiff();
  }
}

function clearDiff(): void {
  const state = loadState();
  state.diff = '';
  saveState(state);
}

function getDiff(): string {
  const state = loadState();
  return state.diff || '';
}

// CLI if run directly
if (require.main === module) {
  program
    .name('diff-state')
    .description('Manage git diff state')
    .version('1.0.0');

  program
    .command('update')
    .description('Update the diff state with current git changes')
    .action(() => {
      updateDiffState();
    });

  program
    .command('clear')
    .description('Clear the diff state')
    .action(() => {
      clearDiff();
      console.log('Diff state cleared');
    });

  program
    .command('get')
    .description('Get the current diff')
    .action(() => {
      const diff = getDiff();
      console.log(diff);
    });

  program
    .command('state')
    .description('Run the state command (default action)')
    .action(() => {
      updateDiffState();
    });

  // Default action
  if (process.argv.length === 2) {
    updateDiffState();
  } else {
    program.parse(process.argv);
  }
}

export { updateDiffState, clearDiff, getDiff };

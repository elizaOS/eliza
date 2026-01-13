/**
 * Submit tool
 * Submits the current changes as a patch
 * Converted from tools/submit/bin/submit
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { program } from 'commander';
import { registry } from '../registry';

const rootDir = process.env.ROOT || process.env.TMPDIR || '/tmp';
const PATCH_PATH = path.join(rootDir, 'model.patch');
const TEST_PATCH_PATH = path.join(rootDir, 'test.patch');

function submit(): void {
  const repoRoot = String(registry.get('ROOT', process.env.ROOT || '.'));
  
  try {
    // Check if test patch exists and apply it in reverse
    if (fs.existsSync(TEST_PATCH_PATH)) {
      const testPatch = fs.readFileSync(TEST_PATCH_PATH, 'utf-8');
      if (testPatch.trim()) {
        try {
          execSync(`git apply -R < "${TEST_PATCH_PATH}"`, {
            cwd: repoRoot as string,
            stdio: 'ignore'
          });
        } catch (error) {
          console.error('Warning: Failed to reverse test patch');
        }
      }
    }

    // Add all changes and create patch
    execSync('git add -A', { cwd: repoRoot as string, stdio: 'ignore' });
    const patch = execSync('git diff --cached', {
      cwd: repoRoot as string,
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024 // 10MB buffer
    });

    // Write patch to file
    fs.writeFileSync(PATCH_PATH, patch);

    // Output submission markers
    console.log('<<SWE_AGENT_SUBMISSION>>');
    console.log(patch);
    console.log('<<SWE_AGENT_SUBMISSION>>');

  } catch (error) {
    console.error('Error creating submission:', error);
    process.exit(1);
  }
}

// CLI if run directly
if (require.main === module) {
  program
    .name('submit')
    .description('Submit the current changes as a patch')
    .version('1.0.0')
    .action(() => {
      submit();
    });

  // Default action if no arguments
  if (process.argv.length === 2) {
    submit();
  } else {
    program.parse(process.argv);
  }
}

export { submit };

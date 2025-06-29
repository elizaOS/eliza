import { GateConfig } from '../types';
import { execa } from 'execa';

export const gate8Verify: GateConfig = {
  name: 'Gate 8: Final Verification',
  maxTurns: 3,

  prompt: `Perform final verification of the migration.

Run these commands in order:
1. rm -rf dist node_modules .turbo
2. bun install
3. bun run build
4. bunx tsc --noEmit
5. bun test --coverage

All commands must succeed:
- Build: 0 errors
- TypeScript: 0 errors  
- Tests: All passing
- Coverage: >= 95%

If any command fails, fix the issue and run all commands again.`,

  validation: async (context) => {
    try {
      // Clean build
      await execa('rm', ['-rf', 'dist', 'node_modules', '.turbo'], {
        cwd: context.repoPath,
      });

      // Install
      await execa('bun', ['install'], { cwd: context.repoPath });

      // Build
      await execa('bun', ['run', 'build'], { cwd: context.repoPath });

      // TypeScript
      await execa('bunx', ['tsc', '--noEmit'], { cwd: context.repoPath });

      // Tests with coverage
      const testResult = await execa('bun', ['test', '--coverage'], {
        cwd: context.repoPath,
        reject: false,
      });

      // Parse coverage
      const output = testResult.stdout + testResult.stderr;
      const coverageMatch = output.match(/All files\s+\|\s+([\d.]+)/);

      if (coverageMatch) {
        const coverage = parseFloat(coverageMatch[1]);
        context.metadata.currentCoverage = coverage;
        return testResult.exitCode === 0 && coverage >= 95;
      }

      return false;
    } catch {
      return false;
    }
  },
};

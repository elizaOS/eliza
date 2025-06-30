import { GateConfig } from '../types';
import { execa } from 'execa';

export const gate6Tests: GateConfig = {
  name: 'Gate 6: Test Implementation',
  maxTurns: 20,
  requiredGuides: ['test_guide'],

  prompt: `Create comprehensive tests using TEST_GUIDE.md to achieve 95%+ coverage.

Steps:
1. Create src/__tests__/ directory
2. Create test-utils.ts with ALL mock functions from TEST_GUIDE.md Section 2
3. Write tests for each component:
   - Actions: Follow TEST_GUIDE.md Section 3
   - Providers: Follow TEST_GUIDE.md Section 4
   - Evaluators: Follow TEST_GUIDE.md Section 5 (if any)
   - Services: Follow TEST_GUIDE.md Section 6 (if any)

After creating each test file:
1. Run 'bun test --coverage' to check coverage
2. Look at the coverage report
3. Add more tests for uncovered lines

Common areas needing coverage:
- Error cases (Section 8)
- Edge cases (Section 9.4)
- All branches (Section 9.7)

Keep adding tests until coverage is >= 95%.
List each test file as you create it.`,

  validation: async (context) => {
    try {
      const result = await execa('bun', ['test', '--coverage'], {
        cwd: context.repoPath,
        reject: false,
      });

      // Parse coverage from output
      const output = result.stdout + result.stderr;
      const coverageMatch = output.match(/All files\s+\|\s+([\d.]+)/);

      if (coverageMatch) {
        const coverage = parseFloat(coverageMatch[1]);
        context.metadata.currentCoverage = coverage;
        return coverage >= 95;
      }

      return false;
    } catch {
      return false;
    }
  },

  onMessage: (message, context) => {
    if (message.type === 'assistant') {
      const text = extractTextFromMessage(message);

      // Track test file creation
      const testFilePatterns = [
        /(?:Created|Writing)\s+(\S+\.test\.ts)/g,
        /test file:\s+(\S+\.test\.ts)/g,
      ];

      for (const pattern of testFilePatterns) {
        const matches = text.matchAll(pattern);
        for (const match of matches) {
          context.metadata.testsCreated.add(match[1]);
          context.metadata.filesCreated.add(match[1]);
        }
      }

      // Track coverage updates
      const coverageMatch = text.match(/Coverage:\s+([\d.]+)%/);
      if (coverageMatch) {
        context.metadata.currentCoverage = parseFloat(coverageMatch[1]);
      }
    }
  },

  retryStrategy: {
    maxAttempts: 3,
    backoffMs: 3000,
  },
};

function extractTextFromMessage(message: any): string {
  if (message.type === 'assistant' && message.message.content) {
    return message.message.content
      .filter((block: any) => block.type === 'text')
      .map((block: any) => ('text' in block ? block.text : ''))
      .join('');
  }
  return '';
}

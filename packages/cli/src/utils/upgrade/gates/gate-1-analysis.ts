import { GateConfig } from '../types';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';

const readFile = promisify(fs.readFile);
const access = promisify(fs.access);

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export const gate1Analysis: GateConfig = {
  name: 'Gate 1: Complete Analysis',
  maxTurns: 5,
  requiredGuides: ['integrated-migration-loop'],

  prompt: `Analyze this ElizaOS plugin for migration from 0.x to 1.x.

Follow the EXACT analysis format from the integrated migration loop guide.

Create a file called MIGRATION_ANALYSIS.md with these sections:

=== PLUGIN MIGRATION ANALYSIS ===
1. FILES TO DELETE (check for biome.json, vitest.config.ts, pnpm-lock.yaml, package-lock.json, yarn.lock, and any other lock files)
2. PACKAGE NAME (current name and if it needs @elizaos/ fix)
3. ACTIONS (list each with all sub-points)
4. PROVIDERS (list each with all sub-points)
5. EVALUATORS (list any found)
6. SERVICES (list any found)
7. SETTINGS USAGE (files importing settings)
8. EXISTING TESTS (what test framework, files)
=== END ANALYSIS ===

Be thorough - examine EVERY TypeScript file in the project.`,

  validation: async (context) => {
    const analysisPath = path.join(context.repoPath, 'MIGRATION_ANALYSIS.md');

    if (!(await pathExists(analysisPath))) {
      return false;
    }

    const content = await readFile(analysisPath, 'utf-8');

    // Check all required sections exist
    const requiredSections = [
      '1. FILES TO DELETE',
      '2. PACKAGE NAME',
      '3. ACTIONS',
      '4. PROVIDERS',
      '5. EVALUATORS',
      '6. SERVICES',
      '7. SETTINGS USAGE',
      '8. EXISTING TESTS',
    ];

    const hasAllSections = requiredSections.every((section) => content.includes(section));

    // Update metadata from analysis
    if (hasAllSections) {
      // Parse analysis to update context metadata
      context.metadata.hasActions = content.includes('src/actions/');
      context.metadata.hasProviders = content.includes('src/providers/');
      context.metadata.hasServices = content.includes('src/services/');
      context.metadata.hasEvaluators = content.includes('src/evaluators/');
    }

    return hasAllSections;
  },

  onMessage: (message, context) => {
    if (message.type === 'assistant') {
      const text = extractTextFromMessage(message);

      // Track files being analyzed
      const fileMatches = text.matchAll(/Analyzing\s+(\S+\.ts)/g);
      for (const match of fileMatches) {
        context.metadata.filesAnalyzed.add(match[1]);
      }
    }
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

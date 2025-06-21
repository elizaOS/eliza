/**
 * PROMPT PARSER MODULE
 * 
 * Responsibilities:
 * - Break down mega prompt into executable chunks
 * - Organize migration phases into structured prompts
 * - Provide phase-specific guidance and critical points
 * - Format prompts for optimal LLM processing
 */

import type { PromptChunk, MigrationPhase } from '../types.js';

/**
 * Break down the mega prompt into executable chunks
 */
export function parseIntoChunks(): PromptChunk[] {
  return [
    {
      id: 'phase1-file-structure',
      title: 'Phase 1: Outside Structure & Build System Migration',
      phase: 'file-structure-migration',
      content: `Update package.json to V2 structure with proper exports, repository info, and scripts.
Remove V1 configuration files (biome.json, vitest.config.ts, jest.config.js).
Update tsconfig.json and create tsconfig.build.json.
Update tsup.config.ts for proper ESM build.
Create CI/CD pipeline (.github/workflows/npm-deploy.yml).
Create images structure with README.md.
Update .gitignore and create .npmignore.`,
      criticalPoints: [
        'Package must be type: "module"',
        'Use ESM exports in package.json',
        'Remove all V1 test configs',
        'Create build-specific tsconfig',
        'Package name must follow @elizaos/plugin-{name} pattern',
      ],
    },
    {
      id: 'phase2-service-layer',
      title: 'Phase 2: Service Layer (CONDITIONAL - Check V1 First)',
      phase: 'core-structure-migration',
      content: `CRITICAL DECISION: Check if V1 plugin had a service/provider class.
      
If V1 plugin had NO service/provider:
- Set services: [] in plugin definition
- Skip service creation entirely
- Most plugins fall into this category

If V1 plugin had a service/provider:
- Create Service class extending base Service
- Implement static serviceType property (no explicit typing)
- Implement static start() method
- Implement stop() method for cleanup
- Implement capabilityDescription getter
- Add proper constructor with runtime parameter`,
      criticalPoints: [
        'CRITICAL: Check V1 plugin first - most plugins do NOT need services',
        'If no service in V1, use services: [] in plugin definition',
        'Only create service if V1 had one',
        'Remove explicit ServiceType annotation (just string literal)',
        'Services auto-register from services array',
      ],
    },
    {
      id: 'phase3-configuration',
      title: 'Phase 3: Configuration Migration',
      phase: 'configuration-migration',
      content: `Create config.ts with Zod validation.
Replace environment.ts usage.
Use runtime.getSetting() for configuration.
Add validation at plugin init.
Use z.coerce.number() for numeric environment variables.`,
      criticalPoints: [
        'Use Zod for schema validation',
        'runtime.getSetting() instead of process.env',
        'Validate config in service constructor',
        'Use z.coerce.number() for ALL numeric fields from env',
      ],
    },
    {
      id: 'phase4-file-migration',
      title: 'Phase 4: File-by-File Code Migration',
      phase: 'actions-migration',
      content: `Process each file completely before moving to the next.
Migrate service files if they exist.
Migrate all action files with V2 patterns.
Migrate provider files to standard interface.
Update all imports and fix all V1 patterns.
Fix all type imports to use type-only syntax.
Update all model API calls.
Fix all parameter names.`,
      criticalPoints: [
        'Process files one by one',
        'Fix all issues in each file completely',
        'Don\'t edit service if not needed',
        'Clean up unnecessary files after migration',
        'Separate type imports from value imports',
        'Use runtime.useModel not language.generateText',
        'Update all ActionExample role to name',
      ],
    },
    {
      id: 'phase5-testing',
      title: 'Phase 5: Test Infrastructure Creation',
      phase: 'testing-infrastructure',
      content: `Delete V1 __tests__ directory completely.
Delete all V1 test configurations.
Create V2 test structure (src/test/).
Copy utils.ts from plugin-coinmarketcap.
Create comprehensive test suite.
Register test suite in plugin definition.
Fix all test type imports.
Update mock runtime for V2.`,
      criticalPoints: [
        'V1 __tests__/ → V2 src/test/',
        'Follow plugin-coinmarketcap structure EXACTLY',
        'Use createMemory not memory.create in mocks',
        'No stubs - full implementation',
        'TestSuite is type-only import',
        'Add useModel to mock runtime',
        'Create proper State objects',
      ],
    },
    {
      id: 'phase6-documentation',
      title: 'Phase 6: Documentation Structure',
      phase: 'documentation-assets',
      content: `Create comprehensive README.md.
Add images/ directory with required assets.
Document configuration requirements.
Document usage examples.
Add development instructions.
Update package name in all documentation.`,
      criticalPoints: [
        'Include installation instructions',
        'Document all environment variables',
        'Add usage examples',
        'Include development commands',
        'Use correct @elizaos/plugin-{name} pattern',
      ],
    },
  ];
}

/**
 * Get prompt chunk by ID
 */
export function getPromptChunkById(id: string): PromptChunk | undefined {
  return parseIntoChunks().find(chunk => chunk.id === id);
}

/**
 * Get prompt chunks by phase
 */
export function getPromptChunksByPhase(phase: MigrationPhase): PromptChunk[] {
  return parseIntoChunks().filter(chunk => chunk.phase === phase);
}

/**
 * Get all migration phases in order
 */
export function getMigrationPhases(): MigrationPhase[] {
  const chunks = parseIntoChunks();
  return chunks.map(chunk => chunk.phase);
}

/**
 * Format prompt chunk for LLM processing
 */
export function formatPromptChunk(chunk: PromptChunk): string {
  let formatted = `# ${chunk.title}\n\n`;
  formatted += `**Phase:** ${chunk.phase}\n\n`;
  formatted += `## Instructions\n\n${chunk.content}\n\n`;
  
  if (chunk.criticalPoints.length > 0) {
    formatted += '## Critical Points\n\n';
    for (const point of chunk.criticalPoints) {
      formatted += `- ${point}\n`;
    }
    formatted += '\n';
  }

  if (chunk.codeExamples && chunk.codeExamples.length > 0) {
    formatted += '## Code Examples\n\n';
    for (const example of chunk.codeExamples) {
      formatted += `### ${example.title}\n\n`;
      formatted += `**Wrong:**\n\`\`\`typescript\n${example.wrong}\n\`\`\`\n\n`;
      formatted += `**Correct:**\n\`\`\`typescript\n${example.correct}\n\`\`\`\n\n`;
    }
  }

  return formatted;
}

/**
 * Generate comprehensive migration prompt from all chunks
 */
export function generateComprehensiveMigrationPrompt(): string {
  const chunks = parseIntoChunks();
  let prompt = '# ElizaOS V1 to V2 Plugin Migration Guide\n\n';
  prompt += 'This is a comprehensive migration guide broken down into phases.\n\n';

  for (const chunk of chunks) {
    prompt += formatPromptChunk(chunk);
    prompt += '---\n\n';
  }

  return prompt;
}

/**
 * Generate phase-specific prompt
 */
export function generatePhasePrompt(phase: MigrationPhase): string {
  const chunks = getPromptChunksByPhase(phase);
  
  if (chunks.length === 0) {
    return `# Phase: ${phase}\n\nNo specific instructions available for this phase.`;
  }

  let prompt = `# Migration Phase: ${phase}\n\n`;
  
  for (const chunk of chunks) {
    prompt += formatPromptChunk(chunk);
  }

  return prompt;
} 
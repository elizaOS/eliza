import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '@elizaos/core';

export interface MigrationGuide {
  name: string;
  path: string;
  content: string;
  category: 'basic' | 'advanced' | 'testing' | 'completion';
  keywords: string[];
}

export interface GuideSearchResult {
  guide: MigrationGuide;
  relevanceScore: number;
  matchedKeywords: string[];
}

export class MigrationGuideLoader {
  private guides: MigrationGuide[] = [];
  private guidesDir: string;

  constructor(projectRoot?: string) {
    // Find guides directory with multiple fallback strategies
    this.guidesDir = this.findGuidesDirectory(projectRoot);
    this.loadGuides();
  }

  private findGuidesDirectory(projectRoot?: string): string {
    // Strategy 1: Use provided project root
    if (projectRoot) {
      const guidesPath = path.join(projectRoot, 'packages/docs/docs/plugins/migration/claude-code');
      if (existsSync(guidesPath)) {
        return guidesPath;
      }
    }

    // Strategy 2: Find project root from current working directory
    let currentRoot = process.cwd();
    let previousRoot = '';
    while (currentRoot !== previousRoot && !existsSync(path.join(currentRoot, 'packages/docs'))) {
      previousRoot = currentRoot;
      currentRoot = path.dirname(currentRoot);
    }

    const monorepoGuidesPath = path.join(
      currentRoot,
      'packages/docs/docs/plugins/migration/claude-code'
    );
    if (existsSync(monorepoGuidesPath)) {
      return monorepoGuidesPath;
    }

    // Strategy 3: Look for guides in the working directory (copied guides)
    const workingDirGuides = path.join(process.cwd(), 'migration-guides');
    if (existsSync(workingDirGuides)) {
      return workingDirGuides;
    }

    // Strategy 4: Look relative to CLI package
    const currentFileUrl = import.meta.url;
    const currentFilePath = fileURLToPath(currentFileUrl);
    const cliPackageRoot = path.dirname(path.dirname(path.dirname(path.dirname(currentFilePath))));
    const bundledGuidesPath = path.join(cliPackageRoot, 'migration-guides');
    if (existsSync(bundledGuidesPath)) {
      return bundledGuidesPath;
    }

    // Strategy 5: Return empty directory - will use embedded guidance
    return '';
  }

  private loadGuides(): void {
    const guideConfigs = [
      {
        name: 'migration-guide.md',
        category: 'basic' as const,
        keywords: [
          'import',
          'path',
          'action',
          'provider',
          'basic',
          'core',
          'elizaLogger',
          'logger',
          'IAgentRuntime',
          'AgentRuntime',
          'Account',
          'Entity',
          'composeContext',
          'generateObject',
          'package.json',
          'dependencies',
          'scripts',
          'build',
        ],
      },
      {
        name: 'state-and-providers-guide.md',
        category: 'basic' as const,
        keywords: [
          'state',
          'provider',
          'ProviderResult',
          'context',
          'memory',
          'runtime',
          'world',
          'room',
          'entityId',
          'userId',
          'optional',
        ],
      },
      {
        name: 'prompt-and-generation-guide.md',
        category: 'basic' as const,
        keywords: [
          'template',
          'prompt',
          'generation',
          'XML',
          'JSON',
          'useModel',
          'generateText',
          'messages',
          'format',
        ],
      },
      {
        name: 'advanced-migration-guide.md',
        category: 'advanced' as const,
        keywords: [
          'service',
          'evaluator',
          'settings',
          'singleton',
          'lifecycle',
          'initialize',
          'start',
          'stop',
          'client',
          'complex',
        ],
      },
      {
        name: 'testing-guide.md',
        category: 'testing' as const,
        keywords: [
          'test',
          'coverage',
          'vitest',
          'bun',
          'mock',
          'unit',
          'integration',
          'error',
          'edge',
          'performance',
          'test-utils',
        ],
      },
      {
        name: 'completion-requirements.md',
        category: 'completion' as const,
        keywords: [
          'release',
          'workflow',
          'npm',
          'deploy',
          'gitignore',
          'npmignore',
          'license',
          'prettier',
          'final',
          'validation',
        ],
      },
    ];

    // If no guides directory found, create embedded guides
    if (!this.guidesDir || !existsSync(this.guidesDir)) {
      logger.info('Using embedded migration guidance (external CLI mode)');
      this.createEmbeddedGuides(guideConfigs);
      return;
    }

    // Load guides from filesystem
    for (const config of guideConfigs) {
      const guidePath = path.join(this.guidesDir, config.name);

      if (existsSync(guidePath)) {
        try {
          const content = readFileSync(guidePath, 'utf-8');
          this.guides.push({
            name: config.name,
            path: guidePath,
            content,
            category: config.category,
            keywords: config.keywords,
          });
        } catch (error) {
          logger.warn(`Failed to load migration guide: ${config.name}`, error);
        }
      } else {
        logger.warn(`Migration guide not found: ${guidePath}`);
      }
    }

    logger.info(`Loaded ${this.guides.length} migration guides from ${this.guidesDir}`);
  }

  private createEmbeddedGuides(guideConfigs: any[]): void {
    // Create minimal embedded guides with essential migration information
    const embeddedGuides = {
      'migration-guide.md': this.getEmbeddedMigrationGuide(),
      'testing-guide.md': this.getEmbeddedTestingGuide(),
      'completion-requirements.md': this.getEmbeddedCompletionGuide(),
    };

    for (const config of guideConfigs) {
      const embeddedContent = embeddedGuides[config.name as keyof typeof embeddedGuides];
      if (embeddedContent) {
        this.guides.push({
          name: config.name,
          path: `embedded:${config.name}`,
          content: embeddedContent,
          category: config.category,
          keywords: config.keywords,
        });
      }
    }
  }

  private getEmbeddedMigrationGuide(): string {
    return `# ElizaOS Plugin Migration Guide - Essential Steps

## Core Migration Requirements

### 1. Import Path Updates
- elizaLogger → logger
- IAgentRuntime → AgentRuntime  
- Account → Entity
- userId → entityId

### 2. Package.json Updates
- Update to @elizaos/core ^1.0.0
- Update scripts to use bun
- Add proper exports and types

### 3. Action Migration
- Replace composeContext with new patterns
- Convert JSON templates to XML
- Update generateObject to runtime.useModel
- Fix handler patterns

### 4. Provider Migration  
- Add name property
- Return ProviderResult
- Make state parameter required

### 5. Testing Requirements
- Use bun test framework
- Achieve 95%+ coverage
- Test all components thoroughly

For complete details, refer to the comprehensive guides in the ElizaOS documentation.`;
  }

  private getEmbeddedTestingGuide(): string {
    return `# ElizaOS Testing Guide - Essential Requirements

## Test Framework
- Use bun test (not vitest)
- Achieve 95%+ code coverage
- Test all actions, providers, evaluators

## Test Structure
\`\`\`
src/__tests__/
├── test-utils.ts
├── actions/
├── providers/
└── evaluators/
\`\`\`

## Coverage Requirements
- All components must be tested
- Error cases must be covered
- Edge cases must be handled
- Integration tests required

## Common Issues
- Mock all async dependencies
- Clean up after each test
- Use proper test isolation

Run: bun test --coverage`;
  }

  private getEmbeddedCompletionGuide(): string {
    return `# ElizaOS Completion Requirements

## Required Files
- .gitignore
- .npmignore  
- LICENSE
- .prettierrc
- .github/workflows/npm-deploy.yml

## Final Validation
\`\`\`bash
bun run build     # Must pass
bun test          # Must pass  
bunx tsc --noEmit # Must pass
\`\`\`

## Package.json Requirements
- Correct name format
- Version 1.0.0
- Proper exports
- Build scripts
- Test scripts

## Release Workflow
- GitHub workflow for npm publish
- Automated testing
- Version management`;
  }

  /**
   * Search for relevant guides based on keywords or content
   */
  searchGuides(query: string, limit: number = 3): GuideSearchResult[] {
    const queryLower = query.toLowerCase();
    const queryWords = queryLower.split(/\s+/).filter((word) => word.length > 2);

    const results: GuideSearchResult[] = [];

    for (const guide of this.guides) {
      let relevanceScore = 0;
      const matchedKeywords: string[] = [];

      // Check keyword matches
      for (const keyword of guide.keywords) {
        if (queryWords.some((word) => keyword.toLowerCase().includes(word))) {
          relevanceScore += 2;
          matchedKeywords.push(keyword);
        }
      }

      // Check content matches
      const contentLower = guide.content.toLowerCase();
      for (const word of queryWords) {
        const matches = (contentLower.match(new RegExp(word, 'g')) || []).length;
        relevanceScore += matches * 0.5;
      }

      // Boost certain guides for common issues
      if (queryLower.includes('import') && guide.name === 'migration-guide.md') {
        relevanceScore += 3;
      }
      if (queryLower.includes('test') && guide.name === 'testing-guide.md') {
        relevanceScore += 3;
      }
      if (queryLower.includes('state') && guide.name === 'state-and-providers-guide.md') {
        relevanceScore += 3;
      }

      if (relevanceScore > 0) {
        results.push({
          guide,
          relevanceScore,
          matchedKeywords,
        });
      }
    }

    return results.sort((a, b) => b.relevanceScore - a.relevanceScore).slice(0, limit);
  }

  /**
   * Get a specific guide by name
   */
  getGuide(name: string): MigrationGuide | null {
    return this.guides.find((guide) => guide.name === name) || null;
  }

  /**
   * Get all guides of a specific category
   */
  getGuidesByCategory(category: MigrationGuide['category']): MigrationGuide[] {
    return this.guides.filter((guide) => guide.category === category);
  }

  /**
   * Get guides that are most relevant for common migration issues
   */
  getRelevantGuidesForIssue(issue: string): GuideSearchResult[] {
    const issueMap: Record<string, string[]> = {
      import_error: ['import', 'path', 'elizaLogger', 'logger'],
      build_error: ['build', 'typescript', 'package.json', 'dependencies'],
      type_error: ['typescript', 'type', 'IAgentRuntime', 'AgentRuntime'],
      action_migration: ['action', 'composeContext', 'generateObject', 'handler'],
      provider_migration: ['provider', 'ProviderResult', 'state', 'context'],
      test_failure: ['test', 'coverage', 'mock', 'unit'],
      service_migration: ['service', 'lifecycle', 'initialize', 'singleton'],
      template_migration: ['template', 'XML', 'JSON', 'prompt'],
      release_setup: ['release', 'workflow', 'npm', 'deploy'],
    };

    const keywords = issueMap[issue];
    if (!keywords) {
      return this.searchGuides(issue);
    }

    return this.searchGuides(keywords.join(' '));
  }

  /**
   * Generate a comprehensive migration context for Claude
   */
  generateMigrationContext(): string {
    const context = [
      '# ELIZAOS PLUGIN MIGRATION GUIDE REFERENCES',
      '',
      'You have access to the following comprehensive migration guides:',
      '',
    ];

    for (const guide of this.guides) {
      context.push(`## ${guide.name.replace('.md', '').toUpperCase()}`);
      context.push(`Category: ${guide.category}`);
      context.push(`Keywords: ${guide.keywords.join(', ')}`);
      context.push('');

      // Include first 500 characters as preview
      const preview = guide.content.substring(0, 500).replace(/\n/g, ' ');
      context.push(`Preview: ${preview}...`);
      context.push('');
      context.push('---');
      context.push('');
    }

    context.push('## GUIDE USAGE INSTRUCTIONS');
    context.push('');
    context.push('- Reference specific guides for detailed migration steps');
    context.push('- Use migration-guide.md for basic actions and providers');
    context.push('- Use advanced-migration-guide.md for services and evaluators');
    context.push('- Use testing-guide.md for comprehensive test coverage');
    context.push('- Use completion-requirements.md for final release preparation');
    context.push('');

    return context.join('\n');
  }

  /**
   * Get full content of all guides for RAG embedding
   */
  getAllGuidesContent(): string {
    const content = [
      '# COMPLETE ELIZAOS MIGRATION KNOWLEDGE BASE',
      '',
      'This contains all migration guides and their complete content for reference.',
      '',
    ];

    for (const guide of this.guides) {
      content.push(`# GUIDE: ${guide.name}`);
      content.push(`Category: ${guide.category}`);
      content.push(`Keywords: ${guide.keywords.join(', ')}`);
      content.push('');
      content.push('## CONTENT:');
      content.push('');
      content.push(guide.content);
      content.push('');
      content.push('---');
      content.push('');
    }

    return content.join('\n');
  }
}

/**
 * Helper function to create a guide loader instance
 */
export function createMigrationGuideLoader(projectRoot?: string): MigrationGuideLoader {
  return new MigrationGuideLoader(projectRoot);
}

/**
 * Helper function to get migration context for common issues
 */
export function getMigrationHelpForIssue(issue: string, projectRoot?: string): string {
  const loader = createMigrationGuideLoader(projectRoot);
  const results = loader.getRelevantGuidesForIssue(issue);

  if (results.length === 0) {
    return 'No specific guidance found. Check the basic migration-guide.md for general steps.';
  }

  const help = [`MIGRATION GUIDANCE FOR: ${issue.toUpperCase()}`, '', 'Relevant guides found:', ''];

  for (const result of results) {
    help.push(`## ${result.guide.name}`);
    help.push(`Relevance: ${result.relevanceScore.toFixed(1)}`);
    help.push(`Matched: ${result.matchedKeywords.join(', ')}`);
    help.push('');

    // Extract relevant sections
    const sections = result.guide.content.split(/^##\s+/m);
    for (const section of sections.slice(0, 3)) {
      // First 3 sections
      if (section.trim()) {
        help.push(`### ${section.substring(0, 200)}...`);
        help.push('');
      }
    }

    help.push('---');
    help.push('');
  }

  return help.join('\n');
}

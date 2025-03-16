import fs from 'node:fs';
import path from 'node:path';
import type { AIService } from './AIService/AIService.js';
import { FullDocumentationGenerator } from './AIService/generators/FullDocumentationGenerator.js';
import type { Configuration } from './Configuration.js';
import type { GitManager } from './GitManager.js';
import type { ASTQueueItem, EnvUsage, PluginDocumentation, TodoItem } from './types/index.js';

/**
 * Generates comprehensive plugin documentation based on existing JSDoc comments
 */
/**
 * Class for generating comprehensive plugin documentation
 */

export class PluginDocumentationGenerator {
  private fullDocumentationGenerator: FullDocumentationGenerator;
  constructor(
    private aiService: AIService,
    private gitManager: GitManager,
    private configuration: Configuration
  ) {
    this.fullDocumentationGenerator = new FullDocumentationGenerator(configuration);
  }

  /**
   * Generates comprehensive plugin documentation
   * @param {ASTQueueItem[]} existingDocs - Queue of documented items
   * @param {string} branchName - Current git branch name
   * @param {TodoItem[]} todoItems - List of TODO items found in the codebase
   * @param {EnvUsage[]} envUsages - List of environment variable usages
   */
  public async generate(
    existingDocs: ASTQueueItem[],
    branchName?: string,
    todoItems: TodoItem[] = [],
    envUsages: EnvUsage[] = []
  ): Promise<void> {
    // Read package.json
    const packageJsonPath = path.join(this.configuration.absolutePath, 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    if (!packageJson) {
      console.error('package.json not found');
    }
    // Generate documentation
    const documentation = await this.fullDocumentationGenerator.generatePluginDocumentation({
      existingDocs,
      packageJson,
      todoItems,
      envUsages,
    });

    // Generate markdown content
    const markdownContent = this.generateMarkdownContent(documentation, packageJson);

    // Only commit the file if we're in a branch
    if (branchName) {
      // Use the configuration's relative path to determine the correct README location
      const relativeReadmePath = path.join(this.configuration.relativePath, 'README-automated.md');

      // Commit the file to the correct location
      await this.gitManager.commitFile(
        branchName,
        relativeReadmePath,
        markdownContent,
        'docs: Update plugin documentation'
      );
    } else {
      console.error('No branch name provided, skipping commit for README-automated.md');
    }
  }

  private generateMarkdownContent(docs: PluginDocumentation, packageJson: any): string {
    return `# ${packageJson.name} Documentation

## Overview
${docs.overview}

## Installation
${docs.installation}

## Configuration
${docs.configuration}

## Features

### Actions
${docs.actionsDocumentation}

### Providers
${docs.providersDocumentation}

### Evaluators
${docs.evaluatorsDocumentation}

## Usage Examples
${docs.usage}

## FAQ
${docs.faq}

## Development

### TODO Items
${docs.todos}

## Troubleshooting Guide
${docs.troubleshooting}`;
  }
}

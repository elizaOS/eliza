import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Configuration } from '../../Configuration.js';
import { TypeScriptParser } from '../../TypeScriptParser.js';
import type {
  ASTQueueItem,
  EnvUsage,
  PluginDocumentation,
  TodoItem,
  TodoSection,
} from '../../types';
import { PROMPT_TEMPLATES } from '../../utils/prompts';
import { AIService } from '../AIService.js';
import type { FileDocsGroup, OrganizedDocs } from '../types';
import { CodeFormatter } from '../utils/CodeFormatter.js';
import { DocumentOrganizer } from '../utils/DocumentOrganizer.js';

/**
 * Interface representing a Frequently Asked Question (FAQ) with a question and its corresponding answer.
 * @typedef {Object} FAQ
 * @property {string} question - The question being asked.
 * @property {string} answer - The answer to the question.
 */
interface FAQ {
  question: string;
  answer: string;
}

/**
 * Interface representing a troubleshooting issue.
 * @typedef {object} TroubleshootingIssue
 * @property {string} issue - The description of the issue.
 * @property {string} cause - The cause of the issue.
 * @property {string} solution - The solution to the issue.
 */
interface TroubleshootingIssue {
  issue: string;
  cause: string;
  solution: string;
}

/**
 * Interface representing Troubleshooting information.
 * @interface
 */
interface Troubleshooting {
  commonIssues: TroubleshootingIssue[];
  debuggingTips: string[];
}

/**
 * Class representing a FullDocumentationGenerator.
 * @class
 */

export class FullDocumentationGenerator {
  private typeScriptParser: TypeScriptParser;
  private codeFormatter: CodeFormatter;
  private documentOrganizer: DocumentOrganizer;
  private aiService: AIService;

  /**
   * Constructor for initializing the ChatOpenAI instance.
   *
   * @param {Configuration} configuration - The configuration instance to be used
   * @throws {Error} If OPENAI_API_KEY environment variable is not set
   */
  /**
   * Constructor for initializing a new Instance.
   *
   * @param {Configuration} configuration - The configuration for the instance.
   */
  constructor(private configuration: Configuration) {
    this.typeScriptParser = new TypeScriptParser();
    this.codeFormatter = new CodeFormatter();
    this.documentOrganizer = new DocumentOrganizer();
    this.aiService = new AIService(configuration);
  }

  public async generatePluginDocumentation({
    existingDocs,
    packageJson,
    todoItems,
    envUsages,
  }: {
    existingDocs: ASTQueueItem[];
    packageJson: any;
    todoItems: TodoItem[];
    envUsages: EnvUsage[];
  }): Promise<PluginDocumentation> {
    const organizedDocs = this.documentOrganizer.organizeDocumentation(existingDocs);
    const organizedDocsPath = path.join(this.configuration.absolutePath, 'organizedDocs.json');
    await fs.writeFile(organizedDocsPath, JSON.stringify(organizedDocs, null, 2));

    const indexPath = path.join(this.configuration.absolutePath, 'src', 'index.ts');
    const exports = this.typeScriptParser.extractExports(indexPath);

    const actionsDocumentation = await this.generateActionsDocumentation(exports.actions);
    const providersDocumentation = await this.generateProvidersDocumentation(exports.providers);
    const evaluatorsDocumentation = await this.generateEvaluatorsDocumentation(exports.evaluators);

    // Generate overview, FAQ, and troubleshooting together
    const overviewResponse = await this.generateOverview(organizedDocs, packageJson);
    const parsedOverview = JSON.parse(overviewResponse);

    const [installation, configuration, usage, apiRef, todoSection] = await Promise.all([
      this.generateInstallation(packageJson),
      this.generateConfiguration(envUsages),
      this.generateUsage(organizedDocs, packageJson),
      this.generateApiReference(organizedDocs),
      this.generateTodoSection(todoItems),
    ]);

    // Format the FAQ and troubleshooting sections
    const formattedFAQ = this.formatFAQSection(parsedOverview.faq);
    const formattedTroubleshooting = this.formatTroubleshootingSection(
      parsedOverview.troubleshooting
    );

    return {
      overview: this.formatOverviewSection(parsedOverview.overview),
      installation,
      configuration,
      usage,
      apiReference: apiRef,
      troubleshooting: formattedTroubleshooting,
      faq: formattedFAQ,
      todos: todoSection.todos,
      actionsDocumentation,
      providersDocumentation,
      evaluatorsDocumentation,
    };
  }

  private formatOverviewSection(overview: any): string {
    return `### Purpose\n${overview.purpose}\n\n### Key Features\n${overview.keyFeatures}`;
  }

  private formatFAQSection(faq: FAQ[]): string {
    if (!Array.isArray(faq)) {
      console.warn('FAQ data is not an array, returning empty string');
      return '';
    }

    return faq
      .filter((item) => item.question && item.answer) // Filter out invalid items
      .map((item) => `### Q: ${item.question}\n${item.answer}`)
      .join('\n\n');
  }

  private formatTroubleshootingSection(troubleshooting: Troubleshooting): string {
    if (!troubleshooting?.commonIssues || !troubleshooting?.debuggingTips) {
      console.warn('Troubleshooting data is missing required fields, returning empty string');
      return '';
    }
    const issues = troubleshooting.commonIssues
      .filter(
        (issue: { issue: string; cause: string; solution: string }) =>
          issue.issue && issue.cause && issue.solution
      )
      .map(
        (issue: { issue: string; cause: string; solution: string }) =>
          `### ${issue.issue}\n- Cause: ${issue.cause}\n- Solution: ${issue.solution}`
      )
      .join('\n\n');

    const tips =
      troubleshooting.debuggingTips.length > 0
        ? `### Debugging Tips\n${troubleshooting.debuggingTips.map((tip) => `- ${tip}`).join('\n')}`
        : '';

    return issues + (tips ? `\n\n${tips}` : '');
  }

  private async generateOverview(docs: OrganizedDocs, packageJson: any): Promise<string> {
    const prompt = PROMPT_TEMPLATES.overview(packageJson, docs);
    try {
      const overview = await this.aiService.generateComment(prompt, true);
      return this.cleanJSONResponse(overview);
    } catch (error) {
      console.error('Error generating overview:', error);
      return `# ${packageJson.name}\n\nNo overview available. Please check package documentation.`;
    }
  }

  private cleanJSONResponse(response: string): string {
    // Remove markdown code block syntax if present
    return response
      .replace(/^```json\n/, '') // Remove opening ```json
      .replace(/\n```$/, '') // Remove closing ```
      .trim(); // Remove any extra whitespace
  }

  private async generateInstallation(packageJson: any): Promise<string> {
    const indexPath = path.join(this.configuration.absolutePath, 'src/index.ts');
    const _mainExport = 'plugin';
    let exportName = `${packageJson.name.split('/').pop()}Plugin`;

    try {
      const indexContent = await fs.readFile(indexPath, {
        encoding: 'utf8',
      });
      const exportMatch = indexContent.match(/export const (\w+):/);
      if (exportMatch) {
        exportName = exportMatch[1];
      }

      const prompt = `Generate installation and integration instructions for this ElizaOS plugin:

            Plugin name: ${packageJson.name}
            Main export: ${exportName}
            Index file exports:
            ${indexContent}
            Dependencies: ${JSON.stringify(packageJson.dependencies || {}, null, 2)}
            Peer dependencies: ${JSON.stringify(packageJson.peerDependencies || {}, null, 2)}

            This is a plugin for the ElizaOS agent system. Generate comprehensive installation instructions that include:

            1. How to add the plugin to your ElizaOS project:
               - First, explain that users need to add the following to their agent/package.json dependencies:
                 \`\`\`json
                 {
                   "dependencies": {
                     "${packageJson.name}": "workspace:*"
                   }
                 }
                 \`\`\`
               - Then, explain they need to:
                 1. cd into the agent/ directory
                 2. Run bun install to install the new dependency
                 3. Run bun run build to build the project with the new plugin

            2. After installation, show how to import and use the plugin:
               - Import syntax using: import { ${exportName} } from "${packageJson.name}";
               - How to add it to the AgentRuntime plugins array

            3. Integration example showing the complete setup:
               \`\`\`typescript
               import { ${exportName} } from "${packageJson.name}";

               return new AgentRuntime({
                   // other configuration...
                   plugins: [
                       ${exportName},
                       // other plugins...
                   ],
               });
               \`\`\`

            4. Verification steps to ensure successful integration
                - for this step just tell the user to ensure they see ["✓ Registering action: <plugin actions>"] in the console

            Format the response in markdown, with clear section headers and step-by-step instructions. Emphasize that this is a workspace package that needs to be added to agent/package.json and then built.`;

      return await this.aiService.generateComment(prompt);
    } catch (error) {
      console.error('Error reading index.ts:', error);
      return this.generateBasicInstallPrompt(packageJson);
    }
  }

  private async generateBasicInstallPrompt(packageJson: any): Promise<string> {
    console.log('AIService::generateInstallation threw an error, generating basic install prompt');
    const prompt = `Generate basic installation instructions for this ElizaOS plugin:

        Plugin name: ${packageJson.name}
        Dependencies: ${JSON.stringify(packageJson.dependencies || {}, null, 2)}
        Peer dependencies: ${JSON.stringify(packageJson.peerDependencies || {}, null, 2)}

        This is a plugin for the ElizaOS agent system. Include basic setup instructions.`;

    return await this.aiService.generateComment(prompt);
  }

  private async generateConfiguration(envUsages: EnvUsage[]): Promise<string> {
    const prompt = `Generate configuration documentation based on these environment variable usages:
        ${envUsages
          .map(
            (item) => `
        Environment Variable: ${item.code}
        Full Context: ${item.fullContext}
        `
          )
          .join('\n')}
        Create comprehensive configuration documentation that:
        1. Lists all required environment variables and their purpose
        2. Return a full .env example file

        Inform the user that the configuration is done in the .env file.
        And to ensure the .env is set in the .gitignore file so it is not committed to the repository.

        Format the response in markdown with proper headings and code blocks.`;

    return await this.aiService.generateComment(prompt);
  }

  private async generateUsage(docs: OrganizedDocs, _packageJson: any): Promise<string> {
    const fileGroups = this.documentOrganizer.groupDocsByFile(docs);
    // write fileGroups to a json file
    const fileGroupsPath = path.join(this.configuration.absolutePath, 'fileGroups.json');
    await fs.writeFile(fileGroupsPath, JSON.stringify(fileGroups, null, 2));
    const sections: string[] = [];

    // Generate documentation for each file without individual intros
    for (const fileGroup of fileGroups) {
      const fileDoc = await this.generateFileUsageDoc(fileGroup);
      if (fileDoc.trim()) {
        sections.push(fileDoc);
      }
    }

    return sections.join('\n\n');
  }

  private async generateApiReference(docs: OrganizedDocs): Promise<string> {
    const fileGroups = this.documentOrganizer.groupDocsByFile(docs);
    const sections: string[] = [];

    for (const fileGroup of fileGroups) {
      const fileDoc = await this.generateFileApiDoc(fileGroup);
      if (fileDoc.trim()) {
        sections.push(fileDoc);
      }
    }

    return sections.join('\n');
  }

  /**
   * Generates troubleshooting guide based on documentation and common patterns
   */
  // toDo - integrate w/ @Jin's discord scraper to pull solutions for known issues
  private async generateTroubleshooting(docs: OrganizedDocs, packageJson: any): Promise<string> {
    const prompt = `${PROMPT_TEMPLATES.troubleshooting}\n\nFor package: ${packageJson.name}\n\nWith content:\n${JSON.stringify(docs, null, 2)}`;
    return await this.aiService.generateComment(prompt);
  }

  private async generateFileUsageDoc(fileGroup: FileDocsGroup): Promise<string> {
    const filePath = this.codeFormatter.formatFilePath(fileGroup.filePath);
    const prompt = `${PROMPT_TEMPLATES.fileUsageDoc}\n\nFor file: ${filePath}\n\nWith components:\n${this.codeFormatter.formatComponents(fileGroup)}`;
    const doc = await this.aiService.generateComment(prompt);
    return `### ${filePath}\n\n${doc}`;
  }

  private async generateFileApiDoc(fileGroup: FileDocsGroup): Promise<string> {
    const filePath = this.codeFormatter.formatFilePath(fileGroup.filePath);
    const formattedDocs = this.codeFormatter.formatApiComponents(fileGroup);
    // Add TypeScript code block for the file path to indicate it's a TypeScript module
    return formattedDocs ? `### File: \`${filePath}\`\n${formattedDocs}` : '';
  }

  private async generateProviderDoc(provider: any): Promise<string> {
    const prompt = `${PROMPT_TEMPLATES.providerDoc}\n\nWith content:\n${JSON.stringify(provider, null, 2)}`;
    return await this.aiService.generateComment(prompt);
  }

  /**
   * Generates TODO section documentation from found TODO comments
   */
  // toDo - integrate w/ @Jin's discord scraper to auto create GH issues/bounties
  private async generateTodoSection(todoItems: TodoItem[]): Promise<TodoSection> {
    if (todoItems.length === 0) {
      return { todos: 'No TODO items found.', todoCount: 0 };
    }

    const prompt = `${PROMPT_TEMPLATES.todos}\n\nWith items:\n${todoItems
      .map((item) => `- Comment: ${item.comment}\n  Context: ${item.fullContext}`)
      .join('\n')}`;

    const todos = await this.aiService.generateComment(prompt);
    return { todos, todoCount: todoItems.length };
  }

  private resolveTypeScriptFilePath(file: string): string {
    // Remove leading ./ if present
    const relativePath = file.replace(/^\.\//, '');

    // Ensure the path has .ts extension
    const pathWithExtension = this.codeFormatter.ensureTypeScriptExtension(relativePath);

    // Join with the absolute path and src directory
    return path.join(this.configuration.absolutePath, 'src', pathWithExtension);
  }

  ///////////////////////////////
  /// Eliza Specific Constructs//
  ///////////////////////////////

  private async generateActionsDocumentation(actionsFiles: string[]): Promise<string> {
    let documentation = '';

    for (const file of actionsFiles) {
      // Remove ./ prefix and ensure path includes src directory and .ts extension
      const filePath = this.resolveTypeScriptFilePath(file);

      try {
        const ast = this.typeScriptParser.parse(filePath);
        const bounds = this.typeScriptParser.findActionBounds(ast);

        if (!bounds) {
          console.warn(`No action bounds found in ${filePath}`);
          continue;
        }

        const actionCode = this.typeScriptParser.extractActionCode(filePath, bounds);

        // Use PROMPT_TEMPLATES.actionDoc
        const prompt = `${PROMPT_TEMPLATES.actionDoc}\n\nWith content:\n\`\`\`typescript\n${actionCode}\n\`\`\``;

        const actionDocumentation = await this.aiService.generateComment(prompt);
        if (actionDocumentation.trim()) {
          documentation += `${actionDocumentation}\n\n`;
        }
      } catch (error) {
        console.warn(`Warning: Could not process action file ${filePath}:`, error);
      }
    }

    if (!documentation.trim()) {
      return 'No actions documentation available.';
    }

    return documentation;
  }

  private async generateProvidersDocumentation(providersFiles: string[]): Promise<string> {
    let documentation = '';

    for (const file of providersFiles) {
      // Remove ./ prefix and ensure path includes src directory and .ts extension
      const relativePath = file.replace(/^\.\//, '');
      const filePath = this.resolveTypeScriptFilePath(file);

      try {
        const content = await fs.readFile(filePath, 'utf-8');
        // Create a provider object with relevant information
        const provider = {
          fileName: relativePath,
          content: content,
          // Extract provider properties
          name: relativePath.split('/').pop()?.replace('.ts', ''),
        };

        const providerDocumentation = await this.generateProviderDoc(provider);
        if (providerDocumentation.trim()) {
          documentation += `${providerDocumentation}\n\n`;
        }
      } catch (error) {
        console.warn(`Warning: Could not read provider file ${filePath}:`, error);
      }
    }

    if (!documentation.trim()) {
      return 'No providers documentation available.';
    }

    return documentation;
  }

  private async generateEvaluatorsDocumentation(evaluatorsFiles: string[]): Promise<string> {
    let documentation = '';

    for (const file of evaluatorsFiles) {
      // Remove ./ prefix and ensure path includes src directory and .ts extension
      const relativePath = file.replace(/^\.\//, '');
      const filePath = this.resolveTypeScriptFilePath(file);

      try {
        const content = await fs.readFile(filePath, 'utf-8');
        const prompt = `Generate documentation for the following Evaluator:
                    \`\`\`typescript
                    ${content}
                    \`\`\`

                    Provide an overview of the evaluator's purpose and functionality.

                    Format in markdown without adding any additional headers.`;

        const evaluatorDocumentation = await this.aiService.generateComment(prompt);
        if (evaluatorDocumentation.trim()) {
          documentation += `### ${relativePath}\n\n${evaluatorDocumentation}\n\n`;
        }
      } catch (error) {
        console.warn(`Warning: Could not read evaluator file ${filePath}:`, error);
      }
    }

    if (!documentation.trim()) {
      return 'No evaluators documentation available.';
    }

    return documentation;
  }
}

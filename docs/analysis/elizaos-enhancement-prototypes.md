# ElizaOS Enhancement Prototypes

Ce document fournit des prototypes de code concrets pour les enhancements suggérés dans l'analyse comparative.

---

## 1. LitePlugin / Instructions System

### 1.1 Types

```typescript
// packages/core/src/types/instruction.ts

export interface InstructionMetadata {
  name: string;
  description: string;
  version?: string;
  author?: string;
  license?: string;
  triggers?: string[];
  allowedActions?: string[];
  allowedProviders?: string[];
}

export interface InstructionScript {
  path: string;
  language: 'python' | 'bash' | 'node';
  description: string;
}

export interface Instruction {
  metadata: InstructionMetadata;
  content: string;           // Le markdown parsé
  scripts?: InstructionScript[];
  references?: string[];     // Chemins vers les fichiers de référence
  basePath: string;          // Dossier de l'instruction
}

export interface InstructionResult {
  text: string;              // Instructions formatées pour le prompt
  metadata: InstructionMetadata;
  availableScripts: InstructionScript[];
}
```

### 1.2 Loader d'Instructions

```typescript
// packages/core/src/instructions/loader.ts

import { parse as parseYaml } from 'yaml';
import { Instruction, InstructionMetadata } from '../types/instruction';

export class InstructionLoader {
  private instructionsDir: string;
  private cache: Map<string, Instruction> = new Map();

  constructor(instructionsDir: string = './instructions') {
    this.instructionsDir = instructionsDir;
  }

  async loadAll(): Promise<Map<string, InstructionMetadata>> {
    const metadata = new Map<string, InstructionMetadata>();
    const dirs = await this.scanDirectories();

    for (const dir of dirs) {
      const instruction = await this.loadInstruction(dir);
      if (instruction) {
        metadata.set(instruction.metadata.name, instruction.metadata);
        this.cache.set(instruction.metadata.name, instruction);
      }
    }

    return metadata;
  }

  async getInstruction(name: string): Promise<Instruction | null> {
    if (this.cache.has(name)) {
      return this.cache.get(name)!;
    }

    const instruction = await this.loadInstruction(
      `${this.instructionsDir}/${name}`
    );

    if (instruction) {
      this.cache.set(name, instruction);
    }

    return instruction;
  }

  private async loadInstruction(path: string): Promise<Instruction | null> {
    const instructionFile = Bun.file(`${path}/INSTRUCTION.md`);

    if (!(await instructionFile.exists())) {
      return null;
    }

    const content = await instructionFile.text();
    const { metadata, body } = this.parseFrontmatter(content);

    // Découvrir les scripts
    const scripts = await this.discoverScripts(path);

    // Découvrir les références
    const references = await this.discoverReferences(path);

    return {
      metadata,
      content: body,
      scripts,
      references,
      basePath: path,
    };
  }

  private parseFrontmatter(content: string): {
    metadata: InstructionMetadata;
    body: string;
  } {
    const frontmatterRegex = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;
    const match = content.match(frontmatterRegex);

    if (!match) {
      throw new Error('Invalid INSTRUCTION.md: missing frontmatter');
    }

    const [, yamlContent, body] = match;
    const metadata = parseYaml(yamlContent) as InstructionMetadata;

    return { metadata, body: body.trim() };
  }

  private async discoverScripts(basePath: string): Promise<InstructionScript[]> {
    const scriptsDir = `${basePath}/scripts`;
    const scripts: InstructionScript[] = [];

    try {
      const glob = new Bun.Glob('*');
      for await (const file of glob.scan(scriptsDir)) {
        const ext = file.split('.').pop();
        let language: 'python' | 'bash' | 'node';

        switch (ext) {
          case 'py':
            language = 'python';
            break;
          case 'sh':
          case 'bash':
            language = 'bash';
            break;
          case 'js':
          case 'ts':
            language = 'node';
            break;
          default:
            continue;
        }

        scripts.push({
          path: `${scriptsDir}/${file}`,
          language,
          description: file,
        });
      }
    } catch {
      // Pas de dossier scripts
    }

    return scripts;
  }

  private async discoverReferences(basePath: string): Promise<string[]> {
    const refsDir = `${basePath}/references`;
    const refs: string[] = [];

    try {
      const glob = new Bun.Glob('**/*');
      for await (const file of glob.scan(refsDir)) {
        refs.push(`${refsDir}/${file}`);
      }
    } catch {
      // Pas de dossier references
    }

    return refs;
  }

  private async scanDirectories(): Promise<string[]> {
    const dirs: string[] = [];
    const glob = new Bun.Glob('*/INSTRUCTION.md');

    for await (const file of glob.scan(this.instructionsDir)) {
      dirs.push(`${this.instructionsDir}/${file.replace('/INSTRUCTION.md', '')}`);
    }

    return dirs;
  }
}
```

### 1.3 Instruction Provider

```typescript
// packages/plugin-bootstrap/src/providers/instructions.ts

import {
  type IAgentRuntime,
  type Memory,
  type Provider,
  type ProviderResult,
  type State,
} from '@elizaos/core';
import { InstructionLoader, type Instruction } from '@elizaos/core';

export const instructionsProvider: Provider = {
  name: 'INSTRUCTIONS',
  description: 'Provides relevant procedural instructions based on context',
  dynamic: true,
  position: -50, // Charger tôt dans le contexte

  get: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State
  ): Promise<ProviderResult> => {
    const loader = runtime.getInstructionLoader();
    const query = message.content.text?.toLowerCase() || '';

    // Trouver les instructions pertinentes
    const relevantInstructions = await findRelevantInstructions(
      loader,
      runtime,
      query
    );

    if (relevantInstructions.length === 0) {
      return { text: '', values: {}, data: {} };
    }

    // Formater les instructions pour le prompt
    const formattedInstructions = formatInstructionsForPrompt(relevantInstructions);

    return {
      text: `\n# Active Instructions\n\n${formattedInstructions}`,
      values: {
        activeInstructions: relevantInstructions.map(i => i.metadata.name),
        hasInstructions: true,
      },
      data: {
        instructions: relevantInstructions,
        availableScripts: relevantInstructions.flatMap(i => i.scripts || []),
      },
    };
  },
};

async function findRelevantInstructions(
  loader: InstructionLoader,
  runtime: IAgentRuntime,
  query: string
): Promise<Instruction[]> {
  const allMetadata = await loader.loadAll();
  const relevant: Instruction[] = [];

  for (const [name, metadata] of allMetadata) {
    // Match par triggers
    const matchesTrigger = metadata.triggers?.some(trigger =>
      query.includes(trigger.toLowerCase())
    );

    if (matchesTrigger) {
      const instruction = await loader.getInstruction(name);
      if (instruction) {
        relevant.push(instruction);
      }
      continue;
    }

    // Match par recherche sémantique (optionnel)
    if (runtime.hasService('embedding')) {
      const similarity = await computeSimilarity(
        runtime,
        query,
        metadata.description
      );
      if (similarity > 0.7) {
        const instruction = await loader.getInstruction(name);
        if (instruction) {
          relevant.push(instruction);
        }
      }
    }
  }

  // Limiter à 3 instructions maximum
  return relevant.slice(0, 3);
}

function formatInstructionsForPrompt(instructions: Instruction[]): string {
  return instructions.map(inst => {
    const scriptsSection = inst.scripts?.length
      ? `\n### Available Scripts\n${inst.scripts.map(s =>
          `- \`${s.path}\` (${s.language}): ${s.description}`
        ).join('\n')}`
      : '';

    return `## ${inst.metadata.name}\n\n${inst.content}${scriptsSection}`;
  }).join('\n\n---\n\n');
}

async function computeSimilarity(
  runtime: IAgentRuntime,
  text1: string,
  text2: string
): Promise<number> {
  // Utiliser le service d'embeddings pour calculer la similarité cosinus
  const embeddingService = runtime.getService('embedding');
  if (!embeddingService) return 0;

  const [emb1, emb2] = await Promise.all([
    embeddingService.embed(text1),
    embeddingService.embed(text2),
  ]);

  return cosineSimilarity(emb1, emb2);
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}
```

---

## 2. Script Executor Service

### 2.1 Interface et Implémentation

```typescript
// packages/core/src/services/scriptExecutor.ts

import { Service, type IAgentRuntime, ServiceType, logger } from '@elizaos/core';

export interface ScriptExecutionOptions {
  script: string;
  language: 'python' | 'bash' | 'node';
  args?: string[];
  input?: string;
  timeout?: number;
  cwd?: string;
  env?: Record<string, string>;
}

export interface ScriptExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  duration: number;
}

export class ScriptExecutorService extends Service {
  static serviceType = 'script_executor' as ServiceType;
  capabilityDescription = 'Execute Python, Bash, and Node.js scripts safely';

  private sandboxEnabled: boolean;

  constructor(protected runtime: IAgentRuntime) {
    super(runtime);
    this.sandboxEnabled = runtime.getSetting('SCRIPT_SANDBOX_ENABLED') !== 'false';
  }

  static async start(runtime: IAgentRuntime): Promise<Service> {
    logger.info('Starting ScriptExecutorService');
    const service = new ScriptExecutorService(runtime);
    await service.validateEnvironment();
    return service;
  }

  async stop(): Promise<void> {
    logger.info('Stopping ScriptExecutorService');
  }

  async execute(options: ScriptExecutionOptions): Promise<ScriptExecutionResult> {
    const startTime = Date.now();

    // Validation de sécurité
    this.validateScript(options);

    const command = this.buildCommand(options);
    const timeout = options.timeout || 30000; // 30 secondes par défaut

    try {
      const proc = Bun.spawn(command, {
        cwd: options.cwd || process.cwd(),
        env: { ...process.env, ...options.env },
        stdin: options.input ? 'pipe' : 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });

      // Envoyer l'input si fourni
      if (options.input && proc.stdin) {
        proc.stdin.write(options.input);
        proc.stdin.end();
      }

      // Timeout handling
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          proc.kill();
          reject(new Error(`Script execution timed out after ${timeout}ms`));
        }, timeout);
      });

      const resultPromise = (async () => {
        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        const exitCode = await proc.exited;

        return { stdout, stderr, exitCode };
      })();

      const result = await Promise.race([resultPromise, timeoutPromise]);
      const duration = Date.now() - startTime;

      logger.debug({
        script: options.script,
        language: options.language,
        exitCode: result.exitCode,
        duration,
      }, 'Script execution completed');

      return { ...result, duration };

    } catch (error) {
      logger.error({
        script: options.script,
        error: error instanceof Error ? error.message : String(error),
      }, 'Script execution failed');

      throw error;
    }
  }

  async executeJson<T>(options: ScriptExecutionOptions): Promise<T> {
    const result = await this.execute(options);

    if (result.exitCode !== 0) {
      throw new Error(`Script failed with exit code ${result.exitCode}: ${result.stderr}`);
    }

    try {
      return JSON.parse(result.stdout) as T;
    } catch {
      throw new Error(`Failed to parse JSON output: ${result.stdout}`);
    }
  }

  private buildCommand(options: ScriptExecutionOptions): string[] {
    switch (options.language) {
      case 'python':
        return ['python3', options.script, ...(options.args || [])];
      case 'bash':
        return ['bash', options.script, ...(options.args || [])];
      case 'node':
        return ['node', options.script, ...(options.args || [])];
      default:
        throw new Error(`Unsupported language: ${options.language}`);
    }
  }

  private validateScript(options: ScriptExecutionOptions): void {
    const { script } = options;

    // Vérifier que le script existe
    const file = Bun.file(script);
    if (!file.size) {
      throw new Error(`Script not found: ${script}`);
    }

    // Vérifier l'extension
    const ext = script.split('.').pop();
    const validExtensions: Record<string, string[]> = {
      python: ['py'],
      bash: ['sh', 'bash'],
      node: ['js', 'mjs', 'ts'],
    };

    if (!validExtensions[options.language]?.includes(ext || '')) {
      throw new Error(
        `Invalid extension for ${options.language}: expected ${validExtensions[options.language]?.join(', ')}`
      );
    }

    // Sandbox: vérifier que le script est dans un dossier autorisé
    if (this.sandboxEnabled) {
      const allowedPaths = [
        './instructions/',
        './plugins/',
        './scripts/',
      ];

      const isAllowed = allowedPaths.some(p => script.startsWith(p));
      if (!isAllowed) {
        throw new Error(`Script path not allowed: ${script}`);
      }
    }
  }

  private async validateEnvironment(): Promise<void> {
    // Vérifier que Python est disponible
    try {
      const proc = Bun.spawn(['python3', '--version']);
      await proc.exited;
      logger.debug('Python3 available');
    } catch {
      logger.warn('Python3 not available - Python scripts will fail');
    }

    // Vérifier que Bash est disponible
    try {
      const proc = Bun.spawn(['bash', '--version']);
      await proc.exited;
      logger.debug('Bash available');
    } catch {
      logger.warn('Bash not available - Bash scripts will fail');
    }
  }
}
```

### 2.2 Action Utilisant le Script Executor

```typescript
// packages/plugin-data-analysis/src/actions/analyze.ts

import {
  type Action,
  type ActionResult,
  type IAgentRuntime,
  type Memory,
  type HandlerCallback,
  type State,
} from '@elizaos/core';
import { ScriptExecutorService } from '@elizaos/core';

interface AnalysisResult {
  rows: number;
  columns: string[];
  summary: Record<string, unknown>;
  insights: string[];
}

export const analyzeDataAction: Action = {
  name: 'ANALYZE_DATA',
  similes: ['ANALYZE', 'DATA_ANALYSIS', 'STATISTICS'],
  description: 'Analyze a dataset using Python pandas',

  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    // Vérifier que le service est disponible
    const executor = runtime.getService<ScriptExecutorService>('script_executor');
    if (!executor) {
      runtime.logger.warn('ScriptExecutorService not available');
      return false;
    }

    // Vérifier qu'un fichier est mentionné
    const hasFile = message.content.text?.match(/\.(csv|json|xlsx|parquet)/i);
    return !!hasFile;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    options: unknown,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    try {
      const executor = runtime.getService<ScriptExecutorService>('script_executor');
      if (!executor) {
        throw new Error('Script executor not available');
      }

      // Extraire le chemin du fichier du message
      const fileMatch = message.content.text?.match(/([^\s]+\.(csv|json|xlsx|parquet))/i);
      if (!fileMatch) {
        await callback?.({
          text: "I couldn't find a data file in your message. Please specify a CSV, JSON, or Excel file.",
          actions: ['ANALYZE_DATA'],
        });
        return { success: false, error: 'No file specified' };
      }

      const filePath = fileMatch[1];

      await callback?.({
        text: `Analyzing ${filePath}...`,
        actions: ['ANALYZE_DATA'],
        inProgress: true,
      });

      // Exécuter le script Python d'analyse
      const result = await executor.executeJson<AnalysisResult>({
        script: './instructions/data-analysis/scripts/analyze.py',
        language: 'python',
        args: [filePath],
        timeout: 60000, // 1 minute pour les gros fichiers
      });

      // Formater la réponse
      const response = formatAnalysisResponse(result);

      await callback?.({
        text: response,
        actions: ['ANALYZE_DATA'],
      });

      return {
        success: true,
        text: response,
        values: {
          analyzedFile: filePath,
          rowCount: result.rows,
        },
        data: {
          actionName: 'ANALYZE_DATA',
          analysis: result,
        },
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      runtime.logger.error({ error: errorMessage }, 'Data analysis failed');

      await callback?.({
        text: `Analysis failed: ${errorMessage}`,
        actions: ['ANALYZE_DATA'],
        error: true,
      });

      return {
        success: false,
        error: errorMessage,
      };
    }
  },

  examples: [
    [
      {
        name: '{{userName}}',
        content: { text: 'Analyze the sales data in sales_2024.csv' },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'The dataset contains 1,234 rows with columns: date, product, quantity, revenue...',
          actions: ['ANALYZE_DATA'],
        },
      },
    ],
  ],
};

function formatAnalysisResponse(result: AnalysisResult): string {
  const lines = [
    `## Dataset Analysis`,
    ``,
    `**Rows:** ${result.rows.toLocaleString()}`,
    `**Columns:** ${result.columns.join(', ')}`,
    ``,
    `### Summary Statistics`,
  ];

  for (const [col, stats] of Object.entries(result.summary)) {
    lines.push(`- **${col}**: ${JSON.stringify(stats)}`);
  }

  if (result.insights.length > 0) {
    lines.push(``, `### Key Insights`);
    for (const insight of result.insights) {
      lines.push(`- ${insight}`);
    }
  }

  return lines.join('\n');
}
```

---

## 3. Progressive Loading

### 3.1 Plugin Metadata Registry

```typescript
// packages/core/src/plugins/registry.ts

import type { Plugin } from '../types/plugin';

export interface PluginMetadata {
  name: string;
  description: string;
  triggers?: string[];
  priority?: number;
  path: string;  // Chemin pour le chargement dynamique
}

export class PluginRegistry {
  private metadata: Map<string, PluginMetadata> = new Map();
  private loaded: Map<string, Plugin> = new Map();
  private loading: Map<string, Promise<Plugin>> = new Map();

  registerMetadata(meta: PluginMetadata): void {
    this.metadata.set(meta.name, meta);
  }

  registerPlugin(plugin: Plugin): void {
    this.loaded.set(plugin.name, plugin);
  }

  getMetadata(name: string): PluginMetadata | undefined {
    return this.metadata.get(name);
  }

  getAllMetadata(): Map<string, PluginMetadata> {
    return new Map(this.metadata);
  }

  isLoaded(name: string): boolean {
    return this.loaded.has(name);
  }

  getPlugin(name: string): Plugin | undefined {
    return this.loaded.get(name);
  }

  async loadPlugin(name: string): Promise<Plugin> {
    // Déjà chargé
    if (this.loaded.has(name)) {
      return this.loaded.get(name)!;
    }

    // En cours de chargement
    if (this.loading.has(name)) {
      return this.loading.get(name)!;
    }

    const meta = this.metadata.get(name);
    if (!meta) {
      throw new Error(`Plugin not found: ${name}`);
    }

    // Commencer le chargement
    const loadPromise = this.doLoad(meta);
    this.loading.set(name, loadPromise);

    try {
      const plugin = await loadPromise;
      this.loaded.set(name, plugin);
      return plugin;
    } finally {
      this.loading.delete(name);
    }
  }

  private async doLoad(meta: PluginMetadata): Promise<Plugin> {
    const module = await import(meta.path);
    return module.default || module;
  }

  findByTrigger(query: string): PluginMetadata[] {
    const matches: PluginMetadata[] = [];
    const queryLower = query.toLowerCase();

    for (const meta of this.metadata.values()) {
      if (!meta.triggers) continue;

      for (const trigger of meta.triggers) {
        if (queryLower.includes(trigger.toLowerCase())) {
          matches.push(meta);
          break;
        }
      }
    }

    return matches.sort((a, b) => (b.priority || 0) - (a.priority || 0));
  }
}
```

### 3.2 Runtime avec Lazy Loading

```typescript
// packages/core/src/runtime-extension.ts

import { AgentRuntime } from './runtime';
import { PluginRegistry } from './plugins/registry';

export class LazyAgentRuntime extends AgentRuntime {
  private registry: PluginRegistry;

  async initializeWithLazyLoading(): Promise<void> {
    this.registry = new PluginRegistry();

    // Charger uniquement les métadonnées au démarrage
    await this.loadPluginMetadata();

    // Charger les plugins essentiels immédiatement
    await this.loadEssentialPlugins();
  }

  private async loadPluginMetadata(): Promise<void> {
    // Charger depuis un fichier manifest ou scanner les dossiers
    const manifests = await this.scanPluginManifests();

    for (const manifest of manifests) {
      this.registry.registerMetadata(manifest);
    }
  }

  private async loadEssentialPlugins(): Promise<void> {
    const essentials = ['bootstrap', 'sql'];

    for (const name of essentials) {
      const plugin = await this.registry.loadPlugin(name);
      await this.registerPlugin(plugin);
    }
  }

  async activatePluginsForContext(context: string): Promise<void> {
    const matchingPlugins = this.registry.findByTrigger(context);

    for (const meta of matchingPlugins) {
      if (!this.registry.isLoaded(meta.name)) {
        this.logger.info({ plugin: meta.name }, 'Lazy loading plugin');
        const plugin = await this.registry.loadPlugin(meta.name);
        await this.registerPlugin(plugin);
      }
    }
  }

  // Override processMessage pour activer les plugins à la demande
  async processMessage(message: Memory): Promise<void> {
    // Activer les plugins pertinents avant de traiter
    await this.activatePluginsForContext(message.content.text || '');

    // Continuer le traitement normal
    return super.processMessage(message);
  }
}
```

---

## 4. CLI Commands

### 4.1 Commande Create Instruction

```typescript
// packages/cli/src/commands/create-instruction.ts

import { Command } from 'commander';
import { logger } from '@elizaos/core';

const INSTRUCTION_TEMPLATE = `---
name: {{name}}
description: {{description}}
triggers:
  - "{{trigger1}}"
  - "{{trigger2}}"
allowedActions:
  - REPLY
  - READ
---

# {{titleName}} Instructions

## When to Use
Describe when this instruction should be activated.

## Procedure
1. First step
2. Second step
3. Third step

## Examples

### Example 1
User: "example input"
Agent: "example output"

## Notes
Any additional notes or considerations.
`;

export function createInstructionCommand(program: Command): void {
  program
    .command('create instruction <name>')
    .description('Create a new instruction (lite plugin)')
    .option('-d, --description <desc>', 'Description of the instruction')
    .option('-t, --triggers <triggers...>', 'Trigger phrases')
    .option('--with-scripts', 'Include a scripts directory')
    .option('--with-references', 'Include a references directory')
    .action(async (name: string, options) => {
      const instructionDir = `./instructions/${name}`;

      // Vérifier si le dossier existe déjà
      const exists = await Bun.file(`${instructionDir}/INSTRUCTION.md`).exists();
      if (exists) {
        logger.error(`Instruction "${name}" already exists`);
        process.exit(1);
      }

      // Créer le dossier
      await Bun.write(`${instructionDir}/.keep`, '');

      // Générer le contenu
      const content = INSTRUCTION_TEMPLATE
        .replace(/\{\{name\}\}/g, name)
        .replace(/\{\{titleName\}\}/g, toTitleCase(name))
        .replace(/\{\{description\}\}/g, options.description || 'Description here')
        .replace(/\{\{trigger1\}\}/g, name.replace(/-/g, ' '))
        .replace(/\{\{trigger2\}\}/g, `help with ${name.replace(/-/g, ' ')}`);

      await Bun.write(`${instructionDir}/INSTRUCTION.md`, content);

      // Créer les sous-dossiers optionnels
      if (options.withScripts) {
        await Bun.write(`${instructionDir}/scripts/.keep`, '');
        await Bun.write(
          `${instructionDir}/scripts/example.py`,
          `#!/usr/bin/env python3
"""Example script for ${name}"""

import sys
import json

def main():
    # Your logic here
    result = {"status": "success"}
    print(json.dumps(result))

if __name__ == "__main__":
    main()
`
        );
      }

      if (options.withReferences) {
        await Bun.write(`${instructionDir}/references/.keep`, '');
      }

      logger.success(`Created instruction: ${instructionDir}/INSTRUCTION.md`);
      logger.info('Next steps:');
      logger.info(`  1. Edit ${instructionDir}/INSTRUCTION.md`);
      logger.info('  2. Add triggers and procedures');
      if (options.withScripts) {
        logger.info(`  3. Add scripts in ${instructionDir}/scripts/`);
      }
    });
}

function toTitleCase(str: string): string {
  return str
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
```

---

## 5. Hot Reload pour Instructions

```typescript
// packages/core/src/instructions/watcher.ts

import { watch } from 'fs';
import { InstructionLoader } from './loader';
import { logger } from '../logger';

export class InstructionWatcher {
  private loader: InstructionLoader;
  private watchers: ReturnType<typeof watch>[] = [];
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();

  constructor(loader: InstructionLoader) {
    this.loader = loader;
  }

  start(instructionsDir: string = './instructions'): void {
    logger.info({ dir: instructionsDir }, 'Starting instruction watcher');

    const watcher = watch(
      instructionsDir,
      { recursive: true },
      async (eventType, filename) => {
        if (!filename?.endsWith('.md')) return;

        // Debounce pour éviter les reloads multiples
        const existing = this.debounceTimers.get(filename);
        if (existing) {
          clearTimeout(existing);
        }

        this.debounceTimers.set(
          filename,
          setTimeout(() => this.handleChange(filename), 100)
        );
      }
    );

    this.watchers.push(watcher);
  }

  stop(): void {
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];

    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }

  private async handleChange(filename: string): Promise<void> {
    const instructionName = filename.split('/')[0];

    logger.info({ instruction: instructionName }, 'Reloading instruction');

    try {
      // Invalider le cache et recharger
      await this.loader.invalidate(instructionName);
      await this.loader.getInstruction(instructionName);

      logger.success({ instruction: instructionName }, 'Instruction reloaded');
    } catch (error) {
      logger.error({
        instruction: instructionName,
        error: error instanceof Error ? error.message : String(error),
      }, 'Failed to reload instruction');
    }
  }
}
```

---

## 6. Exemple Complet: Instruction Data Analysis

### 6.1 Structure

```
instructions/
└── data-analysis/
    ├── INSTRUCTION.md
    ├── scripts/
    │   ├── analyze.py
    │   ├── visualize.py
    │   └── requirements.txt
    └── references/
        └── pandas-cheatsheet.md
```

### 6.2 INSTRUCTION.md

```yaml
---
name: data-analysis
description: Analyze datasets, create visualizations, and generate statistical insights using Python pandas
version: "1.0.0"
author: "ElizaOS Team"
triggers:
  - "analyze"
  - "data"
  - "csv"
  - "statistics"
  - "chart"
  - "visualization"
  - "excel"
  - "spreadsheet"
allowedActions:
  - READ
  - WRITE
  - REPLY
  - ANALYZE_DATA
---

# Data Analysis Instructions

## When to Activate

Activate these instructions when the user:
- Mentions analyzing data, CSV files, spreadsheets, or Excel files
- Asks for statistics, summaries, or insights from data
- Requests charts, graphs, or visualizations
- Wants to understand patterns in their data

## Core Capabilities

1. **Read & Parse**: CSV, JSON, Excel, Parquet files
2. **Summarize**: Descriptive statistics, data types, missing values
3. **Analyze**: Correlations, distributions, outliers
4. **Visualize**: Charts, plots, histograms
5. **Export**: Save results to various formats

## Procedure

### Step 1: Understand the Request
- What file does the user want to analyze?
- What kind of analysis are they looking for?
- Do they need visualizations?

### Step 2: Load and Validate Data
Use `scripts/analyze.py` with the file path:
```bash
python scripts/analyze.py path/to/file.csv
```

### Step 3: Interpret Results
The script returns JSON with:
- `rows`: Number of records
- `columns`: List of column names
- `dtypes`: Data types per column
- `summary`: Statistical summary
- `missing`: Missing value counts
- `insights`: Auto-generated insights

### Step 4: Communicate Findings
Present findings in a clear, structured way:
- Start with high-level overview
- Highlight key statistics
- Point out interesting patterns
- Suggest next steps

### Step 5: Handle Visualizations (if requested)
Use `scripts/visualize.py`:
```bash
python scripts/visualize.py path/to/file.csv --type histogram --column revenue
```

## Available Scripts

### analyze.py
Statistical analysis script. Returns JSON.
```
Usage: python analyze.py <file_path> [--sample N]
```

### visualize.py
Visualization script. Generates PNG images.
```
Usage: python visualize.py <file_path> --type <chart_type> --column <column_name>
Types: histogram, bar, line, scatter, pie
```

## Example Interactions

### Example 1: Basic Analysis
**User**: Can you analyze sales_2024.csv?
**Agent**: I'll analyze that file for you.

[Runs analyze.py]

Here's what I found in sales_2024.csv:

**Overview**
- 12,345 rows × 8 columns
- Date range: Jan 2024 - Dec 2024
- No missing values detected

**Key Statistics**
- Total Revenue: $1.2M
- Average Order: $98.50
- Top Product Category: Electronics (34%)

**Insights**
- Revenue peaks in Q4 (holiday season)
- Weekend sales are 23% higher than weekdays
- Mobile orders growing 15% month-over-month

Would you like me to create any visualizations or dig deeper into specific aspects?

### Example 2: Visualization Request
**User**: Show me a chart of monthly revenue
**Agent**: I'll create a revenue chart for you.

[Runs visualize.py --type line --column revenue]

Here's the monthly revenue trend: [chart]

The visualization shows clear seasonality with peaks in November-December.

## Error Handling

- If file not found: Ask user to verify the path
- If file too large: Suggest sampling with `--sample`
- If column not found: List available columns
- If Python error: Show error message and suggest fixes

## Notes

- Maximum recommended file size: 100MB
- For larger files, use `--sample 10000` flag
- Charts are saved to `./output/charts/`
- Supported formats: CSV, JSON, XLSX, Parquet
```

### 6.3 scripts/analyze.py

```python
#!/usr/bin/env python3
"""
Data analysis script for ElizaOS
"""

import sys
import json
import argparse
from pathlib import Path

try:
    import pandas as pd
    import numpy as np
except ImportError:
    print(json.dumps({
        "error": "Required packages not installed. Run: pip install pandas numpy"
    }))
    sys.exit(1)


def analyze_file(filepath: str, sample_size: int = None) -> dict:
    """Analyze a data file and return statistics."""

    path = Path(filepath)

    if not path.exists():
        return {"error": f"File not found: {filepath}"}

    # Read file based on extension
    ext = path.suffix.lower()
    try:
        if ext == '.csv':
            df = pd.read_csv(filepath)
        elif ext == '.json':
            df = pd.read_json(filepath)
        elif ext in ['.xlsx', '.xls']:
            df = pd.read_excel(filepath)
        elif ext == '.parquet':
            df = pd.read_parquet(filepath)
        else:
            return {"error": f"Unsupported file format: {ext}"}
    except Exception as e:
        return {"error": f"Failed to read file: {str(e)}"}

    # Sample if requested
    if sample_size and len(df) > sample_size:
        df = df.sample(n=sample_size, random_state=42)

    # Basic info
    result = {
        "rows": len(df),
        "columns": list(df.columns),
        "dtypes": {col: str(dtype) for col, dtype in df.dtypes.items()},
        "memory_mb": round(df.memory_usage(deep=True).sum() / 1024 / 1024, 2),
    }

    # Missing values
    missing = df.isnull().sum()
    result["missing"] = {col: int(count) for col, count in missing.items() if count > 0}

    # Summary statistics for numeric columns
    numeric_cols = df.select_dtypes(include=[np.number]).columns
    if len(numeric_cols) > 0:
        summary = df[numeric_cols].describe().to_dict()
        # Convert numpy types to Python types
        result["summary"] = {
            col: {k: float(v) if pd.notna(v) else None for k, v in stats.items()}
            for col, stats in summary.items()
        }

    # Categorical columns info
    cat_cols = df.select_dtypes(include=['object', 'category']).columns
    if len(cat_cols) > 0:
        result["categorical"] = {
            col: {
                "unique": int(df[col].nunique()),
                "top_values": df[col].value_counts().head(5).to_dict()
            }
            for col in cat_cols
        }

    # Generate insights
    result["insights"] = generate_insights(df, result)

    return result


def generate_insights(df: pd.DataFrame, stats: dict) -> list:
    """Generate automatic insights from the data."""
    insights = []

    # Check for missing data
    if stats.get("missing"):
        total_missing = sum(stats["missing"].values())
        pct = total_missing / (stats["rows"] * len(stats["columns"])) * 100
        if pct > 5:
            insights.append(f"Warning: {pct:.1f}% of data is missing")

    # Check for numeric outliers
    for col, summary in stats.get("summary", {}).items():
        if summary.get("std") and summary.get("mean"):
            cv = summary["std"] / abs(summary["mean"]) if summary["mean"] != 0 else 0
            if cv > 1:
                insights.append(f"High variability in '{col}' (CV={cv:.2f})")

    # Check for potential duplicates
    if df.duplicated().sum() > 0:
        dup_pct = df.duplicated().sum() / len(df) * 100
        insights.append(f"Found {dup_pct:.1f}% potential duplicate rows")

    # Check date columns for time range
    date_cols = df.select_dtypes(include=['datetime64']).columns
    for col in date_cols:
        date_range = df[col].max() - df[col].min()
        insights.append(f"'{col}' spans {date_range.days} days")

    return insights


def main():
    parser = argparse.ArgumentParser(description='Analyze data files')
    parser.add_argument('filepath', help='Path to the data file')
    parser.add_argument('--sample', type=int, help='Sample size for large files')

    args = parser.parse_args()

    result = analyze_file(args.filepath, args.sample)
    print(json.dumps(result, indent=2, default=str))


if __name__ == "__main__":
    main()
```

---

## Conclusion

Ces prototypes montrent comment ElizaOS peut évoluer pour:

1. **Attirer plus de développeurs** avec des Instructions légères en markdown
2. **Supporter l'écosystème Python** via le ScriptExecutorService
3. **Améliorer les performances** avec le lazy loading progressif
4. **Simplifier l'onboarding** avec des commandes CLI intuitives

Le tout sans casser la compatibilité avec les plugins TypeScript existants.

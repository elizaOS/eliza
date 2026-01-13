#!/usr/bin/env node
/**
 * CLI tool for validating files against SWE-agent rules
 */

import { Command } from 'commander';
import * as path from 'path';
import * as fs from 'fs';
import { validateFiles, formatValidationResults } from './validators';
import { exportAllRulesToCursor } from './config';
import { getApplicableRules } from './general';

const program = new Command();

program.name('swe-rules').description('SWE-agent rules validation and management CLI').version('1.0.0');

/**
 * Validate command
 */
program
  .command('validate')
  .description('Validate files against SWE-agent coding rules')
  .argument('[files...]', 'Files to validate (supports wildcards)')
  .option('-l, --language <lang>', 'Language to validate (python or typescript)', 'auto')
  .option('-s, --strict', 'Exit with error code if validation fails', false)
  .option('-q, --quiet', 'Only show errors, no warnings', false)
  .action(
    async (
      files: string[],
      options: {
        language?: string;
        strict?: boolean;
        quiet?: boolean;
      },
    ) => {
      try {
        // If no files specified, validate current directory
        if (!files || files.length === 0) {
          files = await findProjectFiles();
        }

        // Expand wildcards and resolve paths
        const resolvedFiles = await resolveFiles(files);

        if (resolvedFiles.length === 0) {
          console.log('No files found to validate');
          process.exit(0);
        }

        console.log(`Validating ${resolvedFiles.length} file(s)...`);

        // Validate all files
        const results = await validateFiles(resolvedFiles);

        // Filter results based on options
        const filteredResults = options.quiet ? results.map((r) => ({ ...r, warnings: [] })) : results;

        // Format and display results
        const output = formatValidationResults(filteredResults);
        console.log(output);

        // Check if any errors
        const hasErrors = results.some((r) => r.violations.some((v) => v.severity === 'error'));

        if (options.strict && hasErrors) {
          process.exit(1);
        }
      } catch (error) {
        console.error('Validation error:', error);
        process.exit(1);
      }
    },
  );

/**
 * List rules command
 */
program
  .command('list-rules')
  .description('List all available validation rules')
  .option('-l, --language <lang>', 'Filter by language (python or typescript)')
  .action((options: { language?: string }) => {
    const languages = options.language ? [options.language] : ['python', 'typescript'];

    for (const lang of languages) {
      console.log(`\n${lang.toUpperCase()} Rules:`);
      console.log('='.repeat(50));

      const rules = getApplicableRules('dummy.' + (lang === 'python' ? 'py' : 'ts'), lang as 'python' | 'typescript');

      for (const rule of rules) {
        console.log(`\n${rule.id}:`);
        console.log(`  Category: ${rule.category}`);
        console.log(`  Rule: ${rule.rule}`);
        console.log(`  Enforcement: ${rule.enforcement}`);
        if (rule.alternatives && rule.alternatives.length > 0) {
          console.log(`  Alternatives: ${rule.alternatives.join(', ')}`);
        }
      }
    }
  });

/**
 * Export rules command
 */
program
  .command('export')
  .description('Export rules to Cursor IDE format')
  .option('-o, --output <dir>', 'Output directory', '.cursor/rules')
  .action(async (options: { output?: string }) => {
    try {
      const outputDir = path.resolve(options.output || '.cursor/rules');

      // Create output directory if it doesn't exist
      await fs.promises.mkdir(outputDir, { recursive: true });

      // Export all rules
      const rules = exportAllRulesToCursor();

      for (const [filename, content] of Object.entries(rules)) {
        const filePath = path.join(outputDir, filename);
        await fs.promises.writeFile(filePath, content, 'utf-8');
        console.log(`Exported: ${filePath}`);
      }

      console.log(`\nSuccessfully exported ${Object.keys(rules).length} rule file(s) to ${outputDir}`);
    } catch (error) {
      console.error('Export error:', error);
      process.exit(1);
    }
  });

/**
 * Info command
 */
program
  .command('info')
  .description('Show information about SWE-agent project structure')
  .action(() => {
    console.log('\nSWE-agent Project Structure');
    console.log('='.repeat(50));

    console.log('\nMain Entry Points:');
    console.log('  - sweagent/run/run_single.py: Single agent instances');
    console.log('  - sweagent/run/run_batch.py: Batch processing/benchmarking');

    console.log('\nCore Components:');
    console.log('  - Agent Class: sweagent/agent/agents.py');
    console.log('  - Environment: sweagent/environment/swe_env.py');
    console.log('  - Execution: Sandboxed Docker containers via SWE-ReX');

    console.log('\nTools:');
    console.log('  - Location: tools/ directory');
    console.log('  - Organization: Bundled and deployed to containers');

    console.log('\nInspectors:');
    console.log('  - CLI: inspector_cli.py');
    console.log('  - Web: sweagent/inspector/server.py');

    console.log('\nTypeScript Conversion:');
    console.log('  - Source: src/ directory');
    console.log('  - Status: In progress');
  });

// Helper functions

async function findProjectFiles(): Promise<string[]> {
  const files: string[] = [];
  const extensions = ['.py', '.ts', '.tsx'];

  async function walk(dir: string) {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      // Skip node_modules, dist, build, etc.
      if (
        entry.name.startsWith('.') ||
        entry.name === 'node_modules' ||
        entry.name === 'dist' ||
        entry.name === 'build'
      ) {
        continue;
      }

      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (extensions.includes(ext)) {
          files.push(fullPath);
        }
      }
    }
  }

  await walk(process.cwd());
  return files;
}

async function resolveFiles(patterns: string[]): Promise<string[]> {
  const resolved: string[] = [];

  for (const pattern of patterns) {
    const absPath = path.resolve(pattern);

    try {
      const stat = await fs.promises.stat(absPath);

      if (stat.isFile()) {
        resolved.push(absPath);
      } else if (stat.isDirectory()) {
        // Find all relevant files in directory
        const dirFiles = await findFilesInDir(absPath);
        resolved.push(...dirFiles);
      }
    } catch (error) {
      // Pattern might contain wildcards, try to expand
      // For simplicity, just skip if file doesn't exist
      console.warn(`Warning: Could not resolve pattern: ${pattern}`);
    }
  }

  return Array.from(new Set(resolved)); // Remove duplicates
}

async function findFilesInDir(dir: string): Promise<string[]> {
  const files: string[] = [];
  const extensions = ['.py', '.ts', '.tsx'];

  const entries = await fs.promises.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isFile()) {
      const ext = path.extname(entry.name);
      if (extensions.includes(ext)) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

// Parse command line arguments
program.parse(process.argv);

// Show help if no command provided
if (!process.argv.slice(2).length) {
  program.outputHelp();
}

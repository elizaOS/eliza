import * as fs from 'fs-extra';
import { globby } from 'globby';
import * as path from 'node:path';
import { encoding_for_model } from 'tiktoken';
import { logger } from '@elizaos/core';
import { MAX_TOKENS } from './config.js';

// Initialize tiktoken encoder
const encoder = encoding_for_model('gpt-4');

export interface RepositoryFiles {
  readme: string | null;
  packageJson: string | null;
  index: { path: string; content: string } | null;
  sourceFiles: Array<{ path: string; content: string }>;
}

export async function analyzeRepository(repoPath: string): Promise<string> {
  const files: RepositoryFiles = {
    readme: null,
    packageJson: null,
    index: null,
    sourceFiles: [],
  };

  const readmePath = path.join(repoPath, 'README.md');
  if (await fs.pathExists(readmePath)) {
    files.readme = await fs.readFile(readmePath, 'utf-8');
  }

  const packagePath = path.join(repoPath, 'package.json');
  if (await fs.pathExists(packagePath)) {
    files.packageJson = await fs.readFile(packagePath, 'utf-8');
  }

  const indexPaths = ['index.ts', 'src/index.ts', 'index.js', 'src/index.js'];
  for (const indexPath of indexPaths) {
    const fullPath = path.join(repoPath, indexPath);
    if (await fs.pathExists(fullPath)) {
      files.index = {
        path: indexPath,
        content: await fs.readFile(fullPath, 'utf-8'),
      };
      break;
    }
  }

  const sourceFiles = await globby(['**/*.ts', '**/*.js'], {
    cwd: repoPath,
    ignore: [
      'node_modules/**',
      'dist/**',
      'build/**',
      '*.test.*',
      '*.spec.*',
      'coverage/**',
      'cloned_repos/**',
      '**/*.min.js',
      '**/*.min.ts',
      '**/vendor/**',
      '**/lib/**',
    ],
  });

  let totalTokens = 0;
  const readmeTokens = files.readme ? encoder.encode(files.readme).length : 0;
  const packageTokens = files.packageJson ? encoder.encode(files.packageJson).length : 0;
  const indexTokens = files.index ? encoder.encode(files.index.content).length : 0;

  totalTokens = readmeTokens + packageTokens + indexTokens;

  const sortedFiles = sourceFiles.sort((a, b) => {
    const depthA = a.split('/').length;
    const depthB = b.split('/').length;
    if (depthA !== depthB) return depthA - depthB;
    return a.localeCompare(b);
  });

  for (const file of sortedFiles) {
    if (file === files.index?.path) continue;
    const filePath = path.join(repoPath, file);

    // Check file size before reading
    const stats = await fs.stat(filePath);
    if (stats.size > 1024 * 1024) {
      // Skip files larger than 1MB
      logger.warn(`Skipping large file: ${file} (${stats.size} bytes)`);
      continue;
    }

    const content = await fs.readFile(filePath, 'utf-8');

    // Check if file is likely binary
    if (content.includes('\0')) {
      logger.warn(`Skipping binary file: ${file}`);
      continue;
    }

    const fileTokens = encoder.encode(content).length;
    if (totalTokens + fileTokens > MAX_TOKENS) break;
    files.sourceFiles.push({ path: file, content });
    totalTokens += fileTokens;
  }

  return buildContextString(files);
}

function buildContextString(files: RepositoryFiles): string {
  let context = '';
  if (files.readme) context += `# README.md\n\n${files.readme}\n\n`;
  if (files.packageJson)
    context += `# package.json\n\n\`\`\`json\n${files.packageJson}\n\`\`\`\n\n`;
  if (files.index)
    context += `# ${files.index.path}\n\n\`\`\`typescript\n${files.index.content}\n\`\`\`\n\n`;
  for (const file of files.sourceFiles) {
    context += `# ${file.path}\n\n\`\`\`typescript\n${file.content}\n\`\`\`\n\n`;
  }

  return context;
}

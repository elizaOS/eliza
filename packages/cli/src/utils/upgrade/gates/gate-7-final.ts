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

async function readJson(filePath: string): Promise<any> {
  try {
    const content = await readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

export const gate7Final: GateConfig = {
  name: 'Gate 7: Final Setup',
  maxTurns: 5,
  requiredGuides: ['final_instructions'],

  prompt: `Complete final setup following FINAL_INSTRUCTIONS.md.

Create these required files:
1. .gitignore (Section 1) - copy EXACTLY from guide
2. .npmignore (Section 2) - copy EXACTLY from guide  
3. LICENSE (Section 3) - copy EXACTLY from guide
4. .prettierrc (Section 7) - copy EXACTLY from guide

Create GitHub workflow:
5. Create .github/workflows/npm-deploy.yml (Section 6) - copy EXACTLY

Final steps:
6. Run 'bun run format' to format all code
7. Update README.md - replace all pnpm/npm commands with bun
8. Verify package.json has complete agentConfig section

All files must match the guide exactly.`,

  validation: async (context) => {
    const requiredFiles = [
      '.gitignore',
      '.npmignore',
      'LICENSE',
      '.prettierrc',
      '.github/workflows/npm-deploy.yml',
    ];

    for (const file of requiredFiles) {
      const filePath = path.join(context.repoPath, file);
      if (!(await pathExists(filePath))) {
        return false;
      }
    }

    // Check package.json has agentConfig
    try {
      const packageJson = await readJson(path.join(context.repoPath, 'package.json'));

      if (!packageJson.agentConfig) {
        return false;
      }

      return true;
    } catch {
      return false;
    }
  },

  onMessage: (message, context) => {
    if (message.type === 'assistant') {
      const text = extractTextFromMessage(message);

      // Track file creation
      const filePatterns = [/(?:Created|Creating)\s+(\S+)/g, /File:\s+(\S+)/g];

      for (const pattern of filePatterns) {
        const matches = text.matchAll(pattern);
        for (const match of matches) {
          if (!match[1].includes('/')) {
            context.metadata.filesCreated.add(match[1]);
          }
        }
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

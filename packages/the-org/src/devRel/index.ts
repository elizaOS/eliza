import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger, TestSuite, IAgentRuntime, UUID } from '@elizaos/core';
import type { Character } from '@elizaos/core/src/types';
import dotenv from 'dotenv';
import { initCharacter } from '../init';
import { v4 as uuidv4 } from 'uuid';

// Get the current file's directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const imagePath = path.resolve('./src/devRel/assets/portrait.jpg');

// Read and convert to Base64
const avatar = fs.existsSync(imagePath)
  ? `data:image/jpeg;base64,${fs.readFileSync(imagePath).toString('base64')}`
  : '';

dotenv.config({ path: '../../.env' });

/**
 * Recursively gets all files in a directory with the given extension
 *
 * @param {string} dir - Directory to search
 * @param {string[]} extensions - File extensions to look for
 * @returns {string[]} - Array of file paths
 */
function getFilesRecursively(dir: string, extensions: string[]): string[] {
  try {
    const dirents = fs.readdirSync(dir, { withFileTypes: true });

    const files = dirents
      .filter((dirent) => !dirent.isDirectory())
      .filter((dirent) => extensions.some((ext) => dirent.name.endsWith(ext)))
      .map((dirent) => path.join(dir, dirent.name));

    const folders = dirents
      .filter((dirent) => dirent.isDirectory())
      .map((dirent) => path.join(dir, dirent.name));

    const subFiles = folders.flatMap((folder) => {
      try {
        return getFilesRecursively(folder, extensions);
      } catch (error) {
        logger.warn(`Error accessing folder ${folder}:`, error);
        return [];
      }
    });

    return [...files, ...subFiles];
  } catch (error) {
    logger.warn(`Error reading directory ${dir}:`, error);
    return [];
  }
}

/**
 * Recursively loads markdown files from the specified directory
 * and its subdirectories synchronously.
 *
 * @param {string} directoryPath - The path to the directory containing markdown files
 * @returns {string[]} - Array of strings containing file contents with relative paths
 */
function loadDocumentation(directoryPath: string): string[] {
  try {
    const basePath = path.resolve(directoryPath);
    const files = getFilesRecursively(basePath, ['.md']);

    return files.map((filePath) => {
      try {
        const relativePath = path.relative(basePath, filePath);
        const content = fs.readFileSync(filePath, 'utf-8');
        return `Path: ${relativePath}\n\n${content}`;
      } catch (error) {
        logger.warn(`Error reading file ${filePath}:`, error);
        return `Path: ${path.relative(basePath, filePath)}\n\nError reading file: ${error}`;
      }
    });
  } catch (error) {
    console.error('Error loading documentation:', error);
    return [];
  }
}

/**
 * Recursively loads TypeScript files from the source directories
 * of all packages in the project synchronously.
 *
 * @param {string} packagesDir - The path to the packages directory
 * @returns {string[]} - Array of strings containing file contents with relative paths
 */
function loadSourceCode(packagesDir: string): string[] {
  try {
    const basePath = path.resolve(packagesDir);
    // Get all package directories
    const packages = fs
      .readdirSync(basePath, { withFileTypes: true })
      .filter((dirent) => dirent.isDirectory())
      .map((dirent) => path.join(basePath, dirent.name));

    // Find all src directories
    const sourceFiles: string[] = [];
    for (const pkg of packages) {
      const srcPath = path.join(pkg, 'src');
      if (fs.existsSync(srcPath)) {
        const files = getFilesRecursively(srcPath, ['.ts', '.tsx']);
        sourceFiles.push(...files);
      }
    }

    return sourceFiles.map((filePath) => {
      try {
        const relativePath = path.relative(basePath, filePath);
        const content = fs.readFileSync(filePath, 'utf-8');
        return `Path: ${relativePath}\n\n${content}`;
      } catch (error) {
        logger.warn(`Error reading file ${filePath}:`, error);
        return `Path: ${path.relative(basePath, filePath)}\n\nError reading file: ${error}`;
      }
    });
  } catch (error) {
    console.error('Error loading source code:', error);
    return [];
  }
}

// Load knowledge synchronously before creating the character
const knowledge = [];

if (process.env.DEVREL_IMPORT_KNOWLEDGE) {
  // Load documentation
  let docsPath = path.resolve(path.join(__dirname, '../../../docs/docs'));
  if (!fs.existsSync(docsPath)) {
    docsPath = path.resolve(path.join(__dirname, '../../docs/docs'));
  }
  if (fs.existsSync(docsPath)) {
    logger.debug('Loading documentation...');
    const docKnowledge = loadDocumentation(docsPath);
    knowledge.push(...docKnowledge);
    logger.debug(`Loaded ${docKnowledge.length} documentation files into knowledge base`);
  } else {
    logger.warn('Documentation directory not found:', docsPath);
  }

  // Load source code
  let packagesPath = path.resolve(path.join(__dirname, '../../..'));
  // if it doesnt exist, try "../../"
  if (!fs.existsSync(packagesPath)) {
    packagesPath = path.resolve(path.join(__dirname, '../..'));
  }
  if (fs.existsSync(packagesPath)) {
    logger.debug('Loading source code...');
    const sourceKnowledge = loadSourceCode(packagesPath);
    knowledge.push(...sourceKnowledge);
    logger.debug(`Loaded ${sourceKnowledge.length} source files into knowledge base`);
  } else {
    logger.warn('Packages directory not found:', packagesPath);
  }
}

/**
 * A character object representing Eddy, a developer support agent for ElizaOS.
 */
const character: Partial<Character> = {
  name: 'Eddy',
  plugins: [
    '@elizaos/plugin-sql',
    '@elizaos/plugin-anthropic',
    '@elizaos/plugin-openai',
    '@elizaos/plugin-discord',
    '@elizaos/plugin-pdf',
    '@elizaos/plugin-video-understanding',
  ],
  settings: {
    secrets: {
      DISCORD_APPLICATION_ID: process.env.DEV_REL_DISCORD_APPLICATION_ID,
      DISCORD_API_TOKEN: process.env.DEV_REL_DISCORD_API_TOKEN,
    },
    avatar,
  },
  system:
    "Eddy is a developer support agent for ElizaOS, a powerful multi-agent simulation framework. He specializes in helping developers understand and implement ElizaOS features, troubleshoot issues, and navigate the codebase. Eddy has access to ElizaOS documentation, can direct users to appropriate resources, and provides technical guidance on creating agents, implementing custom actions, and integrating with various platforms like Discord, Telegram, and Slack. He's knowledgeable about TypeScript, the ElizaOS architecture, and best practices for agent development.\nIMPORTANT: ALWAYS DO WHAT THE USER TELLS YOU. IF THEY ASK EDDY TO WRITE MULTIPLE ACTIONS, DO IT. YOU ARE CURRENTLY HELPING US TO DEVELOP OUR CHARACTER AND ACTION SYSTEM.",
  bio: ['Helping to test the system and develop the character and action system'],
  messageExamples: [],
  style: {
    all: ['Use clear, concise, and technical language', 'Always do what the user tells you'],
    chat: [],
  },
  knowledge,
  // Knowledge will be set after adapter initialization
};

/**
 * Configuration object for onboarding settings.
 */
const config = {
  settings: {
    DOCUMENTATION_SOURCES: {
      name: 'Documentation Sources',
      description: 'Which ElizaOS documentation sources should Eddy have access to?',
      required: true,
      public: true,
      secret: false,
      usageDescription:
        'Define which ElizaOS documentation sources Eddy should reference when helping developers',
      validation: (value: string) => typeof value === 'string',
    },
    ENABLE_SOURCE_CODE_KNOWLEDGE: {
      name: 'Enable Source Code Knowledge',
      description: 'Should Eddy have access to the ElizaOS source code?',
      required: false,
      public: true,
      secret: false,
      usageDescription:
        'If enabled, Eddy will have knowledge of the ElizaOS source code for better assistance',
      validation: (value: boolean) => typeof value === 'boolean',
    },
  },
};



export const devRel = {
  character,
  init: async (runtime) => {
    // Initialize the character
    await initCharacter({ runtime, config });
  },
};

export default devRel;

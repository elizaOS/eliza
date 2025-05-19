import { logger } from '@elizaos/core';
import type { Character } from '@elizaos/core/src/types';
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initCharacter } from '../init';

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
    logger.debug(`Loading documentation from: ${basePath}`);

    // Get all markdown files
    const allFiles = getFilesRecursively(basePath, ['.md', '.mdx']);

    // Explicitly define excluded directories
    const excludedDirs = [
      'archive/',
      'community/',
      'news/',
      'packages/',
      'partners/',
      'scripts/',
      'src/',
      'static/',
      'versioned_docs/',
      'versioned_sidebars/',
    ];

    // Filter files based on specified criteria
    const filteredFiles = allFiles.filter((filePath) => {
      const relativePath = path.relative(basePath, filePath);

      // Check if the file is in any of the excluded directories
      for (const dir of excludedDirs) {
        if (relativePath.startsWith(dir)) {
          return false;
        }
      }

      // Always include API directory
      if (relativePath.startsWith('api/')) {
        return true;
      }

      // Always include blog directory
      if (relativePath.startsWith('blog/')) {
        return true;
      }

      // Handle docs/ directory with strict filtering
      if (relativePath.startsWith('docs/')) {
        // Include specified docs directories
        if (
          relativePath.startsWith('docs/cli/') ||
          relativePath.startsWith('docs/core/') ||
          relativePath.startsWith('docs/rest/')
        ) {
          return true;
        }

        // Include only quickstart.md directly in the docs folder
        if (relativePath === 'docs/quickstart.md') {
          return true;
        }

        // Exclude all other files in docs/
        return false;
      }

      // Exclude everything else not explicitly included
      return false;
    });

    logger.debug(
      `Found ${allFiles.length} total documentation files, filtered to ${filteredFiles.length} files`
    );

    return filteredFiles.map((filePath) => {
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
 * Verifies if a directory is likely the packages directory by checking for common packages
 * @param dirPath Path to check
 * @returns Boolean indicating if this is likely the packages directory
 */
function isPackagesDirectory(dirPath: string): boolean {
  if (!fs.existsSync(dirPath)) return false;

  try {
    // Check that it's a directory
    const stats = fs.statSync(dirPath);
    if (!stats.isDirectory()) return false;

    // Check if there are package directories inside with src folders
    const contents = fs.readdirSync(dirPath, { withFileTypes: true });
    const potentialPackages = contents.filter((item) => item.isDirectory());

    // Look for common package names or src directories inside packages
    const hasPackageStructure = potentialPackages.some((pkg) => {
      const packageName = pkg.name;
      const hasSrcDir = fs.existsSync(path.join(dirPath, packageName, 'src'));
      const hasPackageJson = fs.existsSync(path.join(dirPath, packageName, 'package.json'));
      return hasSrcDir && hasPackageJson;
    });

    return hasPackageStructure;
  } catch (error) {
    logger.warn(`Error checking directory ${dirPath}:`, error);
    return false;
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
    // Ensure we have an absolute path to the packages directory
    const basePath = path.resolve(packagesDir);
    logger.debug(`Looking for packages in: ${basePath}`);

    // Get all package directories
    const packageDirs = fs
      .readdirSync(basePath, { withFileTypes: true })
      .filter((dirent) => dirent.isDirectory())
      .map((dirent) => path.join(basePath, dirent.name));

    logger.debug(`Found ${packageDirs.length} potential package directories`);

    // Find all src directories and their TypeScript files
    const sourceFiles: string[] = [];
    for (const pkg of packageDirs) {
      const srcPath = path.join(pkg, 'src');
      if (fs.existsSync(srcPath)) {
        logger.debug(`Processing source files in: ${pkg}`);

        // Get all typescript files from the src directory
        const files = getFilesRecursively(srcPath, ['.ts', '.tsx'])
          // Skip non-code files
          .filter((file) => {
            // Skip test files
            if (
              file.includes('__tests__') ||
              file.includes('/test/') ||
              file.includes('.test.') ||
              file.includes('.spec.')
            ) {
              return false;
            }

            // Skip configuration files
            if (
              file.includes('.config.') ||
              file.endsWith('.d.ts') ||
              file.includes('tsconfig.') ||
              file.includes('jest.')
            ) {
              return false;
            }

            // Skip build files
            if (
              file.includes('/dist/') ||
              file.includes('/build/') ||
              file.includes('/node_modules/')
            ) {
              return false;
            }

            // Skip example files if there are too many files
            if (
              sourceFiles.length > 1000 &&
              (file.includes('/examples/') || file.includes('.example.'))
            ) {
              return false;
            }

            return true;
          });

        sourceFiles.push(...files);
      }
    }

    logger.debug(`Found ${sourceFiles.length} source files`);

    // Cap the number of files to avoid memory issues
    const maxFiles = 500;
    let selectedFiles = sourceFiles;
    if (sourceFiles.length > maxFiles) {
      logger.warn(`Too many source files (${sourceFiles.length}), limiting to ${maxFiles}`);

      // Prioritize core files and exclude less important ones
      const priorityFiles = sourceFiles.filter(
        (file) =>
          file.includes('/core/') ||
          file.includes('/types.ts') ||
          file.includes('/utils.ts') ||
          file.includes('/index.ts')
      );

      // Take all priority files plus a selection of others to reach maxFiles
      const remainingFiles = sourceFiles.filter((file) => !priorityFiles.includes(file));
      const numRemainingNeeded = Math.max(0, maxFiles - priorityFiles.length);

      // Sample every Nth file to get a representative selection
      const step = Math.max(1, Math.floor(remainingFiles.length / numRemainingNeeded));
      const sampledFiles = [];
      for (
        let i = 0;
        i < remainingFiles.length && sampledFiles.length < numRemainingNeeded;
        i += step
      ) {
        sampledFiles.push(remainingFiles[i]);
      }

      selectedFiles = [...priorityFiles, ...sampledFiles].slice(0, maxFiles);
      logger.debug(`Selected ${selectedFiles.length} files after priority filtering`);
    }

    return selectedFiles.map((filePath) => {
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
  // Load documentation - Try several possible locations for docs
  let docsPath;

  // Option 1: First check if docs are in the current workspace at packages/docs
  const packagesDocsPath = path.resolve('packages/docs');
  if (fs.existsSync(packagesDocsPath)) {
    docsPath = packagesDocsPath;
    logger.debug(`Found docs at ${packagesDocsPath}`);
  }
  // Option 2: Check relative to the current file
  else {
    const relativeDocsPath = path.resolve(path.join(__dirname, '../../../docs/docs'));
    if (fs.existsSync(relativeDocsPath)) {
      docsPath = relativeDocsPath;
      logger.debug(`Found docs at ${relativeDocsPath}`);
    }
    // Option 3: Try another common location
    else {
      const alternativeDocsPath = path.resolve(path.join(__dirname, '../../docs/docs'));
      if (fs.existsSync(alternativeDocsPath)) {
        docsPath = alternativeDocsPath;
        logger.debug(`Found docs at ${alternativeDocsPath}`);
      }
    }
  }

  // Load the documentation if we found the docs directory
  if (docsPath && fs.existsSync(docsPath)) {
    logger.debug('Loading documentation...');
    const docKnowledge = loadDocumentation(docsPath);
    knowledge.push(...docKnowledge);
    logger.debug(`Loaded ${docKnowledge.length} documentation files into knowledge base`);
  } else {
    logger.warn('Documentation directory not found. Checked multiple locations.');
  }

  // Load source code - Find the packages directory
  let packagesPath;

  // First try the most common location - 'packages' in the current working directory
  const cwdPackagesPath = path.resolve('packages');
  if (fs.existsSync(cwdPackagesPath) && isPackagesDirectory(cwdPackagesPath)) {
    packagesPath = cwdPackagesPath;
    logger.debug(`Found packages directory at ${cwdPackagesPath}`);
  }
  // Try relative to the file location
  else {
    // Option 1: Try the relative path from the current file's directory
    const relativeToFilePackagesPath = path.resolve(path.join(__dirname, '../../../packages'));
    if (
      fs.existsSync(relativeToFilePackagesPath) &&
      isPackagesDirectory(relativeToFilePackagesPath)
    ) {
      packagesPath = relativeToFilePackagesPath;
      logger.debug(`Found packages directory at ${packagesPath}`);
    }
    // Option 2: One level up from the file location
    else {
      const oneUpPackagesPath = path.resolve(path.join(__dirname, '../../packages'));
      if (fs.existsSync(oneUpPackagesPath) && isPackagesDirectory(oneUpPackagesPath)) {
        packagesPath = oneUpPackagesPath;
        logger.debug(`Found packages directory at ${packagesPath}`);
      }
      // If still not found, try some common project structures
      else {
        // Look for the packages directory at common locations
        const possibleLocations = [
          path.resolve('..'), // Parent directory
          path.resolve('../..'), // Grandparent directory
          path.resolve(path.join(__dirname, '../..')), // Two levels up from file
          path.resolve(path.join(__dirname, '../../..')), // Three levels up from file
        ];

        // Find the first location that contains a valid packages directory
        for (const location of possibleLocations) {
          const potentialPackagesDir = path.join(location, 'packages');
          if (fs.existsSync(potentialPackagesDir) && isPackagesDirectory(potentialPackagesDir)) {
            packagesPath = potentialPackagesDir;
            logger.debug(`Found packages directory at ${packagesPath}`);
            break;
          }
          // Also check if the location itself might be the packages directory
          if (isPackagesDirectory(location)) {
            packagesPath = location;
            logger.debug(`Found packages directory at ${packagesPath}`);
            break;
          }
        }

        // If still not found, log a clear error
        if (!packagesPath) {
          logger.warn(`Could not find a valid packages directory after trying multiple paths`);
        }
      }
    }
  }

  if (packagesPath && fs.existsSync(packagesPath)) {
    logger.debug(`Loading source code from ${packagesPath}...`);
    const sourceKnowledge = loadSourceCode(packagesPath);
    knowledge.push(...sourceKnowledge);
    logger.debug(`Loaded ${sourceKnowledge.length} source files into knowledge base`);
  } else {
    logger.warn('Packages directory not found. Checked multiple locations.');
  }
}

/**
 * A character object representing Eddy, a developer support agent for ElizaOS.
 */
const character: Partial<Character> = {
  name: 'Eddy',
  plugins: [
    '@elizaos/plugin-sql',
    '@elizaos/plugin-rag',
    // ...(process.env.ANTHROPIC_API_KEY ? ['@elizaos/plugin-anthropic'] : []),
    '@elizaos/plugin-openrouter',
    ...(process.env.OPENAI_API_KEY ? ['@elizaos/plugin-openai'] : []),
    ...(!process.env.OPENAI_API_KEY ? ['@elizaos/plugin-local-ai'] : []),
    '@elizaos/plugin-discord',
    '@elizaos/plugin-pdf',
    '@elizaos/plugin-video-understanding',
    '@elizaos/plugin-bootstrap',
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

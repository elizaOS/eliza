import fs from 'node:fs';
import path from 'node:path';
import { logger } from '@elizaos/core';
import { Command } from 'commander';
import { execa } from 'execa';
import { handleError } from '@/src/utils/handle-error';

/**
 * Clone a repository from GitHub
 * @param repo The GitHub repository URL or shorthand
 * @param branch The branch to clone
 * @param destination The destination directory
 */
async function cloneRepository(repo: string, branch: string, destination: string): Promise<void> {
  try {
    const repoUrl = `https://github.com/${repo}`;
    logger.info(`Cloning ${repoUrl} (branch: ${branch}) to ${destination}...`);

    // Clone specific branch using execa
    await execa('git', ['clone', '-b', branch, repoUrl, destination], {
      stdio: 'inherit',
    });

    logger.success('Repository cloned successfully');
  } catch (error) {
    throw new Error(`Failed to clone repository: ${error.message}`);
  }
}

/**
 * Display next step instructions after cloning
 */
function displayNextSteps(dir: string): void {
  console.log('\nTo complete the ElizaOS setup, follow these steps:\n');

  // Step 1: Navigate to the project directory
  console.log('1. Navigate to the project directory:');
  console.log(`   cd ${dir}`);

  // Step 2: Install dependencies
  console.log('\n2. Install dependencies:');
  console.log('   bun install');

  // Step 3: Build the project
  console.log('\n3. Build the project:');
  console.log('   bun run build');

  // Step 4: Start ElizaOS
  console.log('\n4. Start ElizaOS:');
  console.log('   bun run start or bun run dev');

  console.log('\nNote: Make sure you have Node.js and bun installed on your system.');
}

export const setupMonorepo = new Command()
  .name('setup-monorepo')
  .description('Clone ElizaOS monorepo from a specific branch, defaults to v2-develop')
  .option('-b, --branch <branch>', 'Branch to install', 'v2-develop')
  .option('-d, --dir <directory>', 'Destination directory', './eliza')
  .action(async (options) => {
    try {
      const { repo, branch, dir } = {
        repo: 'elizaOS/eliza',
        branch: 'v2-develop',
        dir: './eliza',
      };

      // Create destination directory if it doesn't exist
      const destinationDir = path.resolve(process.cwd(), dir);

      // Check if destination directory already exists and is not empty
      if (fs.existsSync(destinationDir)) {
        const files = fs.readdirSync(destinationDir);
        if (files.length > 0) {
          throw new Error(
            `Destination directory ${destinationDir} already exists and is not empty`
          );
        }
      } else {
        fs.mkdirSync(destinationDir, { recursive: true });
      }

      // Clone the repository
      await cloneRepository(repo, branch, destinationDir);

      // Display instructions for next steps
      displayNextSteps(dir);
    } catch (error) {
      handleError(error);
    }
  });

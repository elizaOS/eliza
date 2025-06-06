import { handleError } from '@/src/utils';
import { Command } from 'commander';
import { execa } from 'execa';
import fs from 'node:fs';
import path from 'node:path';
import { emoji } from '../utils/emoji-handler';

/**
 * Clones a GitHub repository at a specified branch into a target directory.
 *
 * @param repo - The GitHub repository in "owner/repo" shorthand or full URL.
 * @param branch - The branch to clone from the repository.
 * @param destination - The directory where the repository will be cloned.
 *
 * @throws {Error} If the specified branch does not exist in the repository.
 * @throws {Error} If cloning fails for any other reason.
 */
async function cloneRepository(repo: string, branch: string, destination: string): Promise<void> {
  try {
    const repoUrl = `https://github.com/${repo}`;

    // Clone specific branch using execa
    await execa('git', ['clone', '-b', branch, repoUrl, destination], {
      stdio: 'inherit',
    });
  } catch (error) {
    // Special handling for likely branch errors
    if (error.message && error.message.includes('exit code 128')) {
      console.error(`\n[X] Branch '${branch}' doesn't exist in the ElizaOS repository.`);
      console.error(`Please specify a valid branch name. Common branches include:`);
      console.error(`  • main - The main branch`);
      console.error(`  • develop - The development branch (default)`);
      console.error(
        `\nFor a complete list of branches, visit: https://github.com/elizaOS/eliza/branches`
      );
      throw new Error(`Branch '${branch}' not found`);
    }
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
  console.log('   bun run start or bun run dev'); // Enhanced bun installation guidance
  console.log(`\n${emoji.list('Prerequisites:')}`);
  console.log(`   ${emoji.bullet('Node.js 23.3.0+')}`);
  console.log(`   ${emoji.bullet('Bun (JavaScript runtime & package manager)')}`);

  console.log(`\n${emoji.rocket("If you don't have Bun installed:")}`);
  const platform = process.platform;

  if (platform === 'win32') {
    console.log('   Windows: powershell -c "irm bun.sh/install.ps1 | iex"');
    console.log('   Alternative: scoop install bun (if you have Scoop)');
  } else {
    console.log('   Linux/macOS: curl -fsSL https://bun.sh/install | bash');
    if (platform === 'darwin') {
      console.log('   macOS alternative: brew install bun (if you have Homebrew)');
    }
  }

  console.log('   More options: https://bun.sh/docs/installation');
  console.log('   After installation, restart your terminal');
}

export const setupMonorepo = new Command()
  .name('setup-monorepo')
  .description('Clone ElizaOS monorepo from a specific branch, defaults to develop')
  .option('-b, --branch <branch>', 'Branch to install', 'develop')
  .option('-d, --dir <directory>', 'Destination directory', './eliza')
  .action(async (options) => {
    try {
      const repo = 'elizaOS/eliza';
      const branch = options.branch || 'develop';
      const dir = options.dir || './eliza';

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

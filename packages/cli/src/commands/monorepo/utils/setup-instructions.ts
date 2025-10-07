import path from 'node:path';
import { emoji } from '@/src/utils/emoji-handler';
import { PlatformInstructions } from '../types';

/**
 * Get platform-specific Bun installation instructions
 */
function getBunInstallInstructions(): PlatformInstructions {
  const platform = process.platform;

  if (platform === 'win32') {
    return {
      platform: 'Windows',
      commands: ['powershell -c "irm bun.sh/install.ps1 | iex"'],
      alternatives: ['scoop install bun (if you have Scoop)'],
    };
  } else {
    const commands = ['curl -fsSL https://bun.sh/install | bash'];
    const alternatives: string[] = [];

    if (platform === 'darwin') {
      alternatives.push('brew install bun (if you have Homebrew)');
    }

    return {
      platform: platform === 'darwin' ? 'macOS' : 'Linux',
      commands,
      alternatives: alternatives.length > 0 ? alternatives : undefined,
    };
  }
}

/**
 * Display the basic setup steps after cloning
 */
function displayBasicSteps(cdPath: string): void {
  console.log('\nTo complete the ElizaOS setup, follow these steps:\n');

  // Step 1: Navigate to the project directory
  console.log('1. Navigate to the project directory:');
  console.log(`   cd ${cdPath}`);

  // Step 2: Install dependencies
  console.log('\n2. Install dependencies:');
  console.log('   bun install');

  // Step 3: Build the project
  console.log('\n3. Build the project:');
  console.log('   bun run build');

  // Step 4: Start ElizaOS
  console.log('\n4. Start ElizaOS:');
  console.log('   bun run start or bun run dev');
}

/**
 * Display prerequisites and Bun installation guidance
 */
function displayPrerequisites(): void {
  console.log(`\n${emoji.list('Prerequisites:')}`);
  console.log(`   ${emoji.bullet('Node.js 23.3.0+')}`);
  console.log(`   ${emoji.bullet('Bun (JavaScript runtime & package manager)')}`);
}

/**
 * Display Bun installation instructions for the current platform
 */
function displayBunInstructions(): void {
  console.log(`\n${emoji.rocket("If you don't have Bun installed:")}`);

  const instructions = getBunInstallInstructions();

  // Display primary installation commands
  instructions.commands.forEach((command) => {
    console.log(`   ${command}`);
  });

  // Display alternatives if any
  if (instructions.alternatives) {
    instructions.alternatives.forEach((alt) => {
      console.log(`   Alternative: ${alt}`);
    });
  }

  console.log('   More options: https://bun.sh/docs/installation');
  console.log('   After installation, restart your terminal');
}

/**
 * Display complete next step instructions after cloning
 *
 * Shows setup steps, prerequisites, and platform-specific installation guidance.
 */
export function displayNextSteps(targetDir: string): void {
  const cdPath = path.relative(process.cwd(), targetDir);

  displayBasicSteps(cdPath);
  displayPrerequisites();
  displayBunInstructions();
}

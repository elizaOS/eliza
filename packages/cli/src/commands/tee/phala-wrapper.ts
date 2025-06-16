import { Command } from 'commander';
import { spawn } from 'node:child_process';
import { elizaLogger } from '@elizaos/core';
import { emoji } from '../../utils/emoji-handler';

/**
 * Wrapper command that delegates to the official Phala CLI
 * This allows using the full Phala CLI functionality as a subcommand
 */
export const phalaCliCommand = new Command('phala')
  .description('Official Phala Cloud CLI - Manage TEE deployments on Phala Cloud')
  .allowUnknownOption()
  .helpOption(false)
  .action(async (_, command) => {
    // Get all arguments after 'phala'
    const args = command.args;

    try {
      elizaLogger.info('Running Phala CLI command:', ['phala', ...args].join(' '));

      // Use npx with --yes flag to auto-install without prompting
      const phalaProcess = spawn('npx', ['--yes', 'phala', ...args], {
        stdio: 'inherit',
        shell: true,
      });

      phalaProcess.on('error', (error) => {
        elizaLogger.error('Failed to execute Phala CLI:', error);

        if (error.message.includes('ENOENT')) {
          elizaLogger.error(
            `\n${emoji.error('Error: npx not found. Please install Node.js and npm:')}`
          );
          elizaLogger.error('   Visit https://nodejs.org or use a version manager like nvm');
          elizaLogger.error(
            '   curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash'
          );
        } else {
          elizaLogger.error(`\n${emoji.error('Error: Failed to execute Phala CLI')}`);
          elizaLogger.error('   Try running directly: npx phala', args.join(' '));
        }
        process.exit(1);
      });

      phalaProcess.on('exit', (code) => {
        if (code !== 0) {
          elizaLogger.warn(`Phala CLI exited with code: ${code}`);
        }
        process.exit(code || 0);
      });
    } catch (error) {
      elizaLogger.error('Error running Phala CLI:', error);
      elizaLogger.error(`\n${emoji.error('Error: Failed to run Phala CLI')}`);
      elizaLogger.error('   Try running Phala CLI directly with: npx phala', args.join(' '));
      elizaLogger.error('   Or visit https://www.npmjs.com/package/phala for more information');
      process.exit(1);
    }
  })
  .configureHelp({
    helpWidth: 100,
  })
  .on('--help', () => {
    console.log('');
    console.log('This command wraps the official Phala Cloud CLI.');
    console.log('The Phala CLI will be automatically downloaded if not already installed.');
    console.log('All arguments are passed directly to the Phala CLI.');
    console.log('');
    console.log('Examples:');
    console.log('  $ elizaos tee phala help');
    console.log('  $ elizaos tee phala auth login <api-key>');
    console.log('  $ elizaos tee phala cvms list');
    console.log('  $ elizaos tee phala cvms create --name my-app --compose ./docker-compose.yml');
    console.log('');
    console.log('For full Phala CLI documentation, run:');
    console.log('  $ npx phala help');
  });

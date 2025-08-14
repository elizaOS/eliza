import { Command } from 'commander';
import { spawn } from 'node:child_process';
import { logger } from '@elizaos/core';
import { emoji } from '../../utils/emoji-handler';

/**
 * Wrapper command that delegates to the official Phala CLI
 * This allows using the full Phala CLI functionality as a subcommand
 */
export const phalaCliCommand = new Command('phala')
  .description('Official Phala Cloud CLI - Manage TEE deployments on Phala Cloud')
  .allowUnknownOption()
  .helpOption(false)
  .allowExcessArguments(true)
  // Capture all arguments after 'phala' using variadic arguments
  .argument('[args...]', 'All arguments to pass to Phala CLI')
  .action(async (...commandArgs) => {
    // Commander.js passes variadic arguments as an array in the first parameter
    const args = Array.isArray(commandArgs[0]) ? commandArgs[0] : [];

    try {
      logger.info(`Running Phala CLI command: phala ${args.join(' ')}`);

      // Use npx with --yes flag to auto-install without prompting
      const phalaProcess = spawn('npx', ['--yes', 'phala', ...args], {
        stdio: 'inherit',
        shell: true,
      });

      phalaProcess.on('error', (error) => {
        logger.error(`Failed to execute Phala CLI: ${error}`);

        if (error.message.includes('ENOENT')) {
          logger.error(
            `\n${emoji.error('Error: npx not found. Please install Node.js and npm:')}`
          );
          logger.error('   Visit https://nodejs.org or use a version manager like nvm');
          logger.error(
            '   curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash'
          );
        } else {
          logger.error(`\n${emoji.error('Error: Failed to execute Phala CLI')}`);
          logger.error(`   Try running directly: npx phala ${args.join(' ')}`);
        }
        process.exit(1);
      });

      phalaProcess.on('exit', (code) => {
        if (code !== 0) {
          logger.warn(`Phala CLI exited with code: ${code}`);
        }
        process.exit(code || 0);
      });
    } catch (error) {
      logger.error(`Error running Phala CLI: ${error}`);
      logger.error(`\n${emoji.error('Error: Failed to run Phala CLI')}`);
      logger.error(`   Try running Phala CLI directly with: npx phala ${args.join(' ')}`);
      logger.error('   Or visit https://www.npmjs.com/package/phala for more information');
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

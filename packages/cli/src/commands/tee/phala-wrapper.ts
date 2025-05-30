import { Command } from 'commander';
import { spawn } from 'node:child_process';
import { elizaLogger } from '@elizaos/core';

/**
 * Wrapper command that delegates to the official Phala CLI
 * This allows using the full Phala CLI functionality as a subcommand
 */
export const phalaCliCommand = new Command('phala')
  .description('Official Phala Cloud CLI - Manage TEE deployments on Phala Cloud')
  .allowUnknownOption()
  .helpOption(false)
  .action(async (options, command) => {
    // Get all arguments after 'cloud'
    const args = command.args;

    try {
      // Spawn the phala CLI with the provided arguments
      const phalaProcess = spawn('npx', ['phala', ...args], {
        stdio: 'inherit',
        shell: true,
      });

      phalaProcess.on('error', (error) => {
        elizaLogger.error('Failed to execute Phala CLI:', error);
        console.error('Error: Failed to execute Phala CLI. Make sure you have npx installed.');
        process.exit(1);
      });

      phalaProcess.on('exit', (code) => {
        process.exit(code || 0);
      });
    } catch (error) {
      elizaLogger.error('Error running Phala CLI:', error);
      console.error(
        'Error: Failed to run Phala CLI. Try running Phala CLI directly with `npx phala`'
      );
      process.exit(1);
    }
  })
  .configureHelp({
    helpWidth: 100,
  })
  .on('--help', () => {
    console.log('');
    console.log('This command wraps the official Phala Cloud CLI.');
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

import { Command } from 'commander';
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
  // Best-effort Commander settings; still prefer rawArgs slicing below for full fidelity.
  .passThroughOptions()
  // Capture all arguments after 'phala' using variadic arguments
  .argument('[args...]', 'All arguments to pass to Phala CLI')
  .action(async (...commandArgs) => {
    // Use rawArgs to preserve exact user-supplied flags; fallback to variadic args if unavailable.
    const cmd = commandArgs[commandArgs.length - 1] as Command;
    const cmdWithRawArgs = cmd as Command & { parent?: { rawArgs?: string[] }; rawArgs?: string[] };
    const raw = cmdWithRawArgs?.parent?.rawArgs ?? cmdWithRawArgs?.rawArgs ?? process.argv;
    // Find 'phala' as a complete argument, not as a substring
    const idx = raw.findIndex((arg: string) => arg === 'phala');
    const args =
      idx >= 0 ? raw.slice(idx + 1) : Array.isArray(commandArgs[0]) ? commandArgs[0] : [];

    try {
      logger.info({ src: 'cli', command: 'tee-phala', args }, 'Running Phala CLI command');

      // Use npx with --yes flag to auto-install without prompting
      // Using Bun.spawn for process execution per project guidelines
      const phalaProcess = Bun.spawn(['npx', '--yes', 'phala', ...args], {
        stdio: ['inherit', 'inherit', 'inherit'],
        onExit(_proc, exitCode, _signalCode, error) {
          if (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.error(
              { src: 'cli', command: 'tee-phala', error: errorMessage, args },
              'Failed to execute Phala CLI'
            );

            // Check if it's an ENOENT-like error (command not found)
            if (errorMessage.includes('ENOENT') || errorMessage.includes('not found')) {
              console.error(
                `\n${emoji.error('Error: npx not found. Please install Node.js and npm:')}`
              );
              console.error('   Visit https://nodejs.org or use a version manager like nvm');
              console.error(
                '   curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash'
              );
            } else {
              console.error(`\n${emoji.error('Error: Failed to execute Phala CLI')}`);
              console.error('   Try running directly: npx phala [args]');
            }
            process.exit(1);
          }

          if (exitCode !== 0) {
            logger.warn(
              { src: 'cli', command: 'tee-phala', code: exitCode },
              'Phala CLI exited with non-zero code'
            );
          }
          process.exit(exitCode || 0);
        },
      });

      // Wait for the process to complete
      await phalaProcess.exited;
    } catch (error) {
      logger.error(
        {
          src: 'cli',
          command: 'tee-phala',
          error: error instanceof Error ? error.message : String(error),
          args,
        },
        'Error running Phala CLI'
      );
      console.error(`\n${emoji.error('Error: Failed to run Phala CLI')}`);
      console.error('   Try running Phala CLI directly with: npx phala [args]');
      console.error('   Or visit https://www.npmjs.com/package/phala for more information');
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

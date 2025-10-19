import { Command } from 'commander';
import { logger } from '@elizaos/core';
import { emoji } from '../../utils/emoji-handler';
import { bunExecInherit, commandExists } from '../../utils/bun-exec';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import path from 'node:path';

type CommandWithRawArgs = Command & {
  rawArgs?: string[];
  parent?: CommandWithRawArgs | null;
};

const findRawArgs = (cmd: Command): string[] => {
  const commandWithRawArgs = cmd as CommandWithRawArgs;
  const parentRawArgs = commandWithRawArgs.parent?.rawArgs;
  if (Array.isArray(parentRawArgs)) {
    return parentRawArgs;
  }
  if (Array.isArray(commandWithRawArgs.rawArgs)) {
    return commandWithRawArgs.rawArgs;
  }
  return process.argv;
};

const sliceArgsAfterSubcommand = (rawArgs: string[], subcommand: string): string[] => {
  const subcommandIndex = rawArgs.findIndex((arg) => arg === subcommand);
  if (subcommandIndex >= 0) {
    return rawArgs.slice(subcommandIndex + 1);
  }
  return [];
};

type EigenBinaryResolution = {
  command: string;
  additionalPath?: string;
};

export const eigenCliCommand = new Command('eigen')
  .description('Eigen CLI - Manage TEE deployments on Eigen infrastructure')
  .allowUnknownOption()
  .helpOption(false)
  .allowExcessArguments(true)
  .passThroughOptions()
  .argument('[args...]', 'All arguments to pass to the Eigen CLI')
  .action(async (...commandArgs) => {
    const cmd = commandArgs[commandArgs.length - 1] as Command;
    const rawArgs = findRawArgs(cmd);
    const argsFromRaw = sliceArgsAfterSubcommand(rawArgs, 'eigen');
    const args =
      argsFromRaw.length > 0 ? argsFromRaw : Array.isArray(commandArgs[0]) ? commandArgs[0] : [];

    const candidateBinaries = (() => {
      const candidates = new Set<string>();
      const fromEnv = process.env.EIGENX_BIN;
      if (fromEnv && fromEnv.trim().length > 0) {
        candidates.add(fromEnv);
      }
      candidates.add('eigenx');
      candidates.add('eigenx-dev');

      const home = process.env.HOME;
      if (home) {
        const potentialDirs = [
          path.join(home, 'bin'),
          path.join(home, '.local', 'bin'),
          path.join(home, '.eigenx', 'bin'),
        ];

        for (const dir of potentialDirs) {
          candidates.add(path.join(dir, 'eigenx'));
          candidates.add(path.join(dir, 'eigenx-dev'));
        }
      }

      const commonDirs = ['/usr/local/bin', '/usr/bin', '/opt/homebrew/bin'];
      for (const dir of commonDirs) {
        candidates.add(path.join(dir, 'eigenx'));
        candidates.add(path.join(dir, 'eigenx-dev'));
      }

      return Array.from(candidates);
    })();

    const resolveCandidate = async (candidate: string): Promise<EigenBinaryResolution | null> => {
      if (path.isAbsolute(candidate)) {
        try {
          const file = Bun.file(candidate);
          const exists = await file.exists();
          if (exists) {
            return { command: candidate, additionalPath: path.dirname(candidate) };
          }
        } catch {
          // Ignore file existence errors and continue checking other candidates
        }
        return null;
      }

      if (await commandExists(candidate)) {
        return { command: candidate };
      }

      return null;
    };

    const ensureEigenCli = async (): Promise<EigenBinaryResolution | null> => {
      for (const candidate of candidateBinaries) {
        const resolved = await resolveCandidate(candidate);
        if (resolved) {
          return resolved;
        }
      }
      return null;
    };

    let resolvedBinary = await ensureEigenCli();

    if (!resolvedBinary) {
      logger.warn('Eigen CLI binary not found in PATH.');
      logger.warn('Attempting to install the Eigen CLI with user consent.');

      const autoInstall = process.env.ELIZA_TEE_EIGEN_AUTO_INSTALL === 'true';
      const isInteractive = process.stdin.isTTY && process.stdout.isTTY;

      if (!autoInstall && !isInteractive) {
        logger.error(
          `\n${emoji.error('Error: Eigen CLI not installed and cannot prompt in non-interactive mode.')}`
        );
        logger.error('   Install manually:');
        logger.error(
          '   curl -fsSL https://eigenx-scripts.s3.us-east-1.amazonaws.com/install-eigenx.sh | bash'
        );
        process.exit(1);
        return;
      }

      let userConsent = autoInstall;

      if (!autoInstall) {
        const rl = readline.createInterface({ input, output });
        console.log('');
        console.log('Eigen CLI Installer');
        console.log('  This will download and install the Eigen CLI by running:');
        console.log(
          '  curl -fsSL https://eigenx-scripts.s3.us-east-1.amazonaws.com/install-eigenx.sh | bash'
        );
        console.log('');
        console.log('The script adds eigenx binaries (eigenx, eigenx-dev) to your PATH.');
        console.log('');
        const answer = (await rl.question('Proceed with Eigen CLI installation? [y/N] '))
          .trim()
          .toLowerCase();
        rl.close();
        userConsent = answer === 'y' || answer === 'yes';
      }

      if (!userConsent) {
        logger.error(`\n${emoji.error('Eigen CLI installation is required to run this command.')}`);
        logger.error('   Installation can be performed at any time using:');
        logger.error(
          '   curl -fsSL https://eigenx-scripts.s3.us-east-1.amazonaws.com/install-eigenx.sh | bash'
        );
        process.exit(1);
        return;
      }

      const curlAvailable = await commandExists('curl');

      if (!curlAvailable) {
        logger.error(`\n${emoji.error('Error: curl is required to install the Eigen CLI.')}`);
        logger.error('   Please install curl and try again.');
        process.exit(1);
        return;
      }

      logger.info('Installing Eigen CLI...');
      try {
        await bunExecInherit('bash', [
          '-c',
          'curl -fsSL https://eigenx-scripts.s3.us-east-1.amazonaws.com/install-eigenx.sh | bash',
        ]);
      } catch (error) {
        logger.error({ error }, 'Eigen CLI installation failed');
        logger.error('   Please review the output above for details.');
        process.exit(1);
        return;
      }

      resolvedBinary = await ensureEigenCli();
      if (!resolvedBinary) {
        logger.error(
          `\n${emoji.error('Error: Eigen CLI installation completed, but binary not found in PATH.')}`
        );
        logger.error('   Ensure your PATH includes the location where eigenx was installed.');
        process.exit(1);
        return;
      }

      logger.info(
        { binary: resolvedBinary.command },
        'Eigen CLI installation completed successfully.'
      );
    }

    const prependPathEntries: string[] = [];
    if (resolvedBinary.additionalPath) {
      prependPathEntries.push(resolvedBinary.additionalPath);
    }

    if (process.env.ELIZA_TEE_EIGEN_EXTRA_PATHS) {
      const extraPaths = process.env.ELIZA_TEE_EIGEN_EXTRA_PATHS.split(path.delimiter)
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
      prependPathEntries.push(...extraPaths);
    }

    const envOverride = (() => {
      if (prependPathEntries.length === 0) {
        return undefined;
      }

      const existingPath = process.env.PATH ?? '';
      const combined = [...prependPathEntries, existingPath]
        .filter((entry) => entry.length > 0)
        .join(path.delimiter);

      return { PATH: combined };
    })();

    logger.info({ args, binary: resolvedBinary.command }, 'Running Eigen CLI command');
    try {
      const result = await bunExecInherit(
        resolvedBinary.command,
        args,
        envOverride ? { env: envOverride } : {}
      );
      process.exit(result.exitCode ?? 0);
    } catch (error) {
      logger.error({ error, args, binary: resolvedBinary.command }, 'Failed to execute Eigen CLI');
      process.exit(1);
    }
  })
  .configureHelp({
    helpWidth: 100,
  })
  .on('--help', () => {
    console.log('');
    console.log('This command wraps the official Eigen CLI (eigenx).');
    console.log('Ensure the Eigen CLI binary is installed and available on your PATH.');
    console.log('All arguments are passed directly to the Eigen CLI.');
    console.log('');
    console.log('Examples:');
    console.log('  $ elizaos tee eigen help');
    console.log('  $ elizaos tee eigen app list');
    console.log('  $ elizaos tee eigen app deploy myregistry/myapp:v1.0');
    console.log('');
    console.log('For full Eigen CLI documentation, run:');
    console.log('  $ eigenx help');
    console.log('');
    console.log('Installation:');
    console.log(
      '  $ curl -fsSL https://eigenx-scripts.s3.us-east-1.amazonaws.com/install-eigenx.sh | bash'
    );
  });

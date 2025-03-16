import fs from 'node:fs';
import os from 'node:os';
import {
  type DeployOptions,
  type Env,
  type UpgradeOptions,
  deploy,
  images,
  listCvms,
  teepods,
  upgrade,
} from '@/src/tee/phala';
import { TEE_SIMULATOR } from '@/src/tee/phala/constants';
import { writeApiKey } from '@/src/tee/phala/credential';
import { DockerOperations } from '@/src/tee/phala/docker';
import { Command } from 'commander';

/**
 * Parses environment variables from given values and a file.
 * @param {string[]} envs - Array of environment variable strings.
 * @param {string} envFile - Path to a file containing environment variables.
 * @returns {Env[]} Array of objects with key-value pairs representing the environment variables.
 */

const parseEnv = (envs: string[], envFile: string): Env[] => {
  // Process environment variables
  const envVars: Record<string, string> = {};
  if (envs) {
    for (const env of envs) {
      if (env.includes('=')) {
        const [key, value] = env.split('=');
        if (key && value) {
          envVars[key] = value;
        }
      }
    }
  }

  if (envFile) {
    const envFileContent = fs.readFileSync(envFile, 'utf8');
    for (const line of envFileContent.split('\n')) {
      if (line.includes('=')) {
        const [key, value] = line.split('=');
        if (key && value) {
          envVars[key] = value;
        }
      }
    }
  }

  // Add environment variables to the payload
  return Object.entries(envVars).map(([key, value]) => ({
    key,
    value,
  }));
};

const setApiKeyCommand = new Command()
  .command('set-apikey')
  .description('Set the X-API-Key for the TEE CLI')
  .argument('<apiKey>', 'The API key to set')
  .action((apiKey: string) => {
    writeApiKey(apiKey);
  });

// Define the `deploy` command
/**
 * Command to deploy to TEE cloud
 *
 * @typedef {object} DeployOptions
 * @property {string} type - The TEE vendor type
 * @property {string} mode - The deployment mode
 * @property {string} name - The name of the docker image or agent being deployed
 * @property {string} compose - The docker compose file to be deployed
 * @property {string[]} env - Environment variables in the form of KEY=VALUE
 * @property {string} envFile - A file containing environment variables
 * @property {boolean} debug - Enable debug mode to print more information
 *
 * @param {DeployOptions} options - The deployment options
 */
const deployCommand = new Command()
  .command('deploy')
  .description('Deploy to TEE cloud')
  .option('-t, --type <type>', 'Specify the TEE vendor type', 'phala')
  .option(
    '-m, --mode <mode>',
    'Specify the deployment mode (e.g., agent docker file)',
    'docker-compose'
  )
  .option('-n, --name <name>', 'Specify the name of the docker image or agent being deployed')
  .option('-c, --compose <compose>', 'Specify the docker compose file to be deployed')
  .option('-e, --env <env...>', 'Specify environment variables in the form of KEY=VALUE')
  .option('--env-file <envFile>', 'Specify a file containing environment variables')
  .option('--debug', 'Enable debug mode to print more information', false)
  .action((options: DeployOptions) => {
    if (!options.type || options.type !== 'phala') {
      console.error('Error: The --type option is required. Currently only phala is supported.');
      process.exit(1);
    }
    if (!options.mode || options.mode !== 'docker-compose') {
      console.error(
        'Error: The --mode option is required. Currently only docker-compose is supported.'
      );
      process.exit(1);
    }
    if (!options.name) {
      console.error('Error: The --name option is required.');
      process.exit(1);
    }
    if (!options.compose) {
      console.error('Error: The --compose option is required.');
      process.exit(1);
    }

    // Process environment variables
    options.envs = parseEnv(options.env || [], options.envFile || '');

    deploy(options);
  });

const teepodsCommand = new Command()
  .command('teepods')
  .description('Query the teepods')
  .action(() => {
    teepods();
  });

const imagesCommand = new Command()
  .command('images')
  .description('Query the images')
  .option('--teepod-id <teepodId>', 'Specify the id of the teepod')
  .action((options: { teepodId: string }) => {
    if (!options.teepodId) {
      console.error('Error: The --teepod-id option is required.');
      process.exit(1);
    }
    images(options.teepodId);
  });

/**
 * Command for upgrading the TEE CLI
 *
 * @param {UpgradeOptions} options - The options for the upgrade command
 */
const upgradeCommand = new Command()
  .command('upgrade')
  .description('Upgrade the TEE CLI')
  .option(
    '-m, --mode <mode>',
    'Specify the deployment mode (e.g., agent docker file or other local testing deployments)',
    'docker-compose'
  )
  .option('--app-id <appId>', 'Specify the app id')
  .option('-e, --env <env...>', 'Specify environment variables in the form of KEY=VALUE')
  .option('--env-file <envFile>', 'Specify a file containing environment variables')
  .option('-c, --compose <compose>', 'Specify the docker compose file to be deployed')
  .action((options: UpgradeOptions) => {
    if (!options.compose) {
      console.error('Error: The --compose option is required.');
      process.exit(1);
    }

    // Process environment variables
    options.envs = parseEnv(options.env || [], options.envFile || '');

    upgrade(options);
  });

/**
 * Command to build a Docker image with specified options.
 *
 * @typedef {Object} Options
 * @property {string} image - Docker image name
 * @property {string} dockerfile - Path to Dockerfile
 * @property {string} tag - Tag for the Docker image
 * @property {string} username - Docker Hub username
 *
 * @param {Options} options - The options for building the Docker image
 * @returns {Promise<void>} - A promise that resolves once the image is built or rejects with an error
 */
const buildCommand = new Command()
  .command('build')
  .description('Build the docker image')
  .requiredOption('-i, --image <name>', 'Docker image name')
  .requiredOption('-u, --username <name>', 'Docker Hub username')
  .requiredOption('-f, --dockerfile <path>', 'Path to Dockerfile')
  .requiredOption('-t, --tag <tag>', 'Tag for the Docker image')
  .action(async (options) => {
    const { image, dockerfile, tag, username } = options;
    const dockerOps = new DockerOperations(image, username);

    try {
      console.log(`Detected system architecture: ${os.arch()}`);
      await dockerOps.buildImage(dockerfile, tag);
    } catch (error) {
      console.error('Docker image build failed:', error);
      process.exit(1);
    }
  });

/**
 * Command to build a docker-compose file for Eliza Agent.
 *
 * @param {Object} options - The options for building the docker-compose file.
 * @param {string} options.image - Docker image name.
 * @param {string} options.username - Docker Hub username.
 * @param {string} options.tag - Tag for the Docker image.
 * @param {string} options.character - Path to the character file.
 * @param {string} options.envFile - Path to environment file.
 * @param {string} options.version - Version of Eliza to run (v1 or v2).
 *
 * @returns {Promise} - Promise that resolves when the docker-compose file is successfully built.
 */
const buildComposeCommand = new Command()
  .command('build-compose')
  .description('Build a docker-compose file for Eliza Agent')
  .requiredOption('-i, --image <name>', 'Docker image name')
  .requiredOption('-u, --username <name>', 'Docker Hub username')
  .requiredOption('-t, --tag <tag>', 'Tag for the Docker image')
  .option('-c, --character <path>', 'Path to the character file')
  .requiredOption('-e, --env-file <path>', 'Path to environment file')
  .option('-v, --version <version>', 'Version of Eliza to run (v1 or v2)', 'v2')
  .action(async (options) => {
    const { image, username, tag, character, envFile, version } = options;
    const dockerOps = new DockerOperations(image, username);

    try {
      const composePath = await dockerOps.buildComposeFile(tag, character, envFile, version);
      console.log(`\nDocker compose file built successfully at: ${composePath}`);
      console.log('\nTo run this compose file, use:');
      console.log(`phala run-local --compose "${composePath}" --env-file "${envFile}"`);
    } catch (error) {
      console.error('Docker compose file build failed:', error);
      process.exit(1);
    }
  });

/**
 * Command to run an Eliza Agent compose file locally
 * @param {Object} options - The options passed to the command
 * @param {string} options.compose - Path to the docker-compose file
 * @param {string} options.envFile - Path to environment file
 * @returns {Promise<void>} - Promise that resolves once the compose file is run locally
 */
const runLocalCommand = new Command()
  .command('run-local')
  .description('Run an Eliza Agent compose file locally')
  .requiredOption('-c, --compose <path>', 'Path to the docker-compose file')
  .requiredOption('-e, --env-file <path>', 'Path to environment file')
  .action(async (options) => {
    const { compose, envFile } = options;
    const dockerOps = new DockerOperations('dummy'); // image name not needed for running compose

    try {
      await dockerOps.runLocalCompose(compose, envFile);
    } catch (error) {
      console.error('Failed to run docker-compose:', error);
      process.exit(1);
    }
  });

/**
 * Represents a command to publish a Docker image to Docker Hub.
 *
 * @param {Object} options - The options for the command.
 * @param {string} options.image - The Docker image name.
 * @param {string} options.username - The Docker Hub username.
 * @param {string} options.tag - The tag of the Docker image to publish.
 * @returns {Promise<void>} A promise that resolves once the Docker image is published successfully.
 */
const publishCommand = new Command()
  .command('publish')
  .description('Publish Docker image to Docker Hub')
  .requiredOption('-i, --image <name>', 'Docker image name')
  .requiredOption('-u, --username <name>', 'Docker Hub username')
  .requiredOption('-t, --tag <tag>', 'Tag of the Docker image to publish')
  .action(async (options) => {
    const { image, username, tag } = options;
    const dockerOps = new DockerOperations(image, username);

    try {
      await dockerOps.pushToDockerHub(tag);
      console.log(`Docker image ${image}:${tag} published to Docker Hub successfully.`);
    } catch (error) {
      console.error('Docker image publish failed:', error);
      process.exit(1);
    }
  });

/**
 * Command to list tags of a Docker image on Docker Hub.
 *
 * @param options - Command line options including image name and Docker Hub username.
 * @returns {Promise<void>} - Promise that resolves after listing the tags.
 */
const listTagsCommand = new Command()
  .command('list-tags')
  .description('List tags of a Docker image on Docker Hub')
  .requiredOption('-i, --image <name>', 'Docker image name')
  .requiredOption('-u, --username <name>', 'Docker Hub username')
  .action(async (options) => {
    const { image, username } = options;
    const dockerOps = new DockerOperations(image, username);

    try {
      const tags = await dockerOps.listPublishedTags();
      if (tags.length > 0) {
        console.log(`Tags for ${username}/${image}:`);
        tags.forEach((tag) => console.log(`- ${tag}`));
      } else {
        console.log(`No tags found for ${username}/${image}`);
      }
    } catch (error) {
      console.error('Failed to list tags:', error);
      process.exit(1);
    }
  });

/**
 * Create a command for running the TEE simulator locally
 * @returns {Promise<void>} A promise that resolves when the simulator has been pulled and run successfully
 */
const simulatorCommand = new Command()
  .command('simulator')
  .description('Pull and run the latest TEE simulator locally')
  .action(async () => {
    const dockerOps = new DockerOperations('simulator');
    try {
      await dockerOps.runSimulator(TEE_SIMULATOR);
    } catch (error) {
      console.error('Failed to run simulator:', error);
      process.exit(1);
    }
  });

const listCvmsCommand = new Command()
  .command('list-cvms')
  .description('List all CVMs for the current user')
  .action(async () => {
    try {
      await listCvms();
    } catch (error) {
      console.error('Failed to list CVMs:', error);
      process.exit(1);
    }
  });

/**
 * A command for managing Phala TEE deployments.
 *
 * @type {Command}
 */
export const phalaCommand = new Command('phala')
  .description('Manage Phala TEE deployments')
  .addCommand(setApiKeyCommand)
  .addCommand(simulatorCommand)
  .addCommand(buildCommand)
  .addCommand(buildComposeCommand)
  .addCommand(runLocalCommand)
  .addCommand(publishCommand)
  .addCommand(deployCommand)
  .addCommand(upgradeCommand)
  .addCommand(listCvmsCommand)
  .addCommand(listTagsCommand)
  .addCommand(teepodsCommand)
  .addCommand(imagesCommand);

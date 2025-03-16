import { exec } from 'node:child_process';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import axios from 'axios';
import Handlebars from 'handlebars';
import {
  COMPOSE_FILES_DIR,
  DOCKER_COMPOSE_ELIZA_V1_TEMPLATE,
  DOCKER_COMPOSE_ELIZA_V2_TEMPLATE,
} from './constants';

const execAsync = promisify(exec);
const LOGS_DIR = '.tee-cloud/logs';
const MAX_CONSOLE_LINES = 10;

/**
 * Class representing DockerOperations for interacting with Docker containers.
 * @class
 */
export class DockerOperations {
  private imageName: string;
  private dockerHubUsername?: string;

  /**
   * Constructor for creating a new image with the specified image name and optional Docker Hub username.
   *
   * @param {string} imageName - The name of the image to be created.
   * @param {string} [dockerHubUsername] - The Docker Hub username if pulling the image from a private repository.
   */
  constructor(imageName: string, dockerHubUsername?: string) {
    this.imageName = imageName;
    this.dockerHubUsername = dockerHubUsername;
    this.ensureLogsDir();
  }

  /**
   * This method ensures that the logs directory exists by creating it if it does not already exist.
   */
  private ensureLogsDir(): void {
    const logsPath = path.resolve(LOGS_DIR);
    if (!fs.existsSync(logsPath)) {
      fs.mkdirSync(logsPath, { recursive: true });
    }
  }

  /**
   * Returns the file path for the log file based on the given operation.
   * @param {string} operation - The operation for which the log file is being created.
   * @returns {string} The file path for the log file.
   */
  private getLogFilePath(operation: string): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    return path.resolve(LOGS_DIR, `${this.imageName}-${operation}-${timestamp}.log`);
  }

  /**
   * Retrieves the system architecture.
   *
   * @returns {string} The system architecture (e.g. "arm64", "amd64", etc.)
   */
  private getSystemArchitecture(): string {
    const arch = os.arch();
    switch (arch) {
      case 'arm':
      case 'arm64':
        return 'arm64';
      case 'x64':
        return 'amd64';
      default:
        return arch;
    }
  }

  /**
   * Spawns a new process with the specified command, arguments, and operation.
   * @param {string} command - The command to execute.
   * @param {string[]} args - The arguments to pass to the command.
   * @param {string} operation - A description of the operation being performed.
   * @returns {Promise<void>} A Promise that resolves when the process completes successfully
   * and rejects if there is an error during the process execution.
   */
  private spawnProcess(command: string, args: string[], operation: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(command, args);
      const logFile = this.getLogFilePath(operation);
      const logStream = fs.createWriteStream(logFile, { flags: 'a' });
      const consoleBuffer: string[] = [];

      const processOutput = (data: Buffer, isError = false) => {
        const lines = data.toString().split('\n');

        // Write to log file
        logStream.write(data);

        // Update console buffer
        lines.forEach((line) => {
          if (line.trim()) {
            consoleBuffer.push(line);
            // Keep only the last MAX_CONSOLE_LINES lines
            if (consoleBuffer.length > MAX_CONSOLE_LINES) {
              consoleBuffer.shift();
            }

            // Clear console and print the buffer
            console.clear();
            console.log(`Latest ${MAX_CONSOLE_LINES} lines (full log at ${logFile}):`);
            console.log('-'.repeat(50));
            consoleBuffer.forEach((bufferedLine) => {
              if (isError) {
                console.error(bufferedLine);
              } else {
                console.log(bufferedLine);
              }
            });
          }
        });
      };

      proc.stdout.on('data', (data) => processOutput(data));
      proc.stderr.on('data', (data) => processOutput(data, true));

      proc.on('close', (code) => {
        logStream.end();
        if (code === 0) {
          console.log(`\nOperation completed. Full log available at: ${logFile}`);
          resolve();
        } else {
          reject(new Error(`Process exited with code ${code}. Check log file: ${logFile}`));
        }
      });

      proc.on('error', (err) => {
        logStream.end();
        reject(err);
      });
    });
  }

  /**
   * Asynchronously builds a Docker image using the provided Dockerfile path and tag.
   *
   * @param {string} dockerfilePath - The path to the Dockerfile to build the image from.
   * @param {string} tag - The tag to assign to the built image.
   * @returns {Promise<void>} A Promise that resolves when the image is successfully built.
   * @throws {Error} If Docker Hub username is not set, an error is thrown.
   */
  async buildImage(dockerfilePath: string, tag: string): Promise<void> {
    try {
      if (!this.dockerHubUsername) {
        throw new Error('Docker Hub username is required for building');
      }

      const arch = this.getSystemArchitecture();
      const fullImageName = `${this.dockerHubUsername}/${this.imageName}:${tag}`;
      console.log(`Building Docker image ${fullImageName}...`);

      const buildArgs = ['build', '-t', fullImageName, '-f', dockerfilePath];

      if (arch === 'arm64') {
        console.log('Detected arm64 architecture, using --platform linux/amd64');
        buildArgs.push('--platform', 'linux/amd64');
      }

      buildArgs.push('.');

      await this.spawnProcess('docker', buildArgs, 'build');
      console.log(`Docker image ${fullImageName} built successfully.`);
    } catch (error) {
      console.error('Error building Docker image:', error);
      throw error;
    }
  }

  /**
   * Asynchronously pushes the Docker image with the specified tag to Docker Hub.
   *
   * @param {string} tag - The tag for the Docker image to push.
   * @returns {Promise<void>} A Promise that resolves when the image is successfully pushed to Docker Hub.
   * @throws {Error} If the Docker Hub username is not provided.
   * @throws {Error} If an error occurs while pushing the image to Docker Hub.
   */
  async pushToDockerHub(tag: string): Promise<void> {
    if (!this.dockerHubUsername) {
      throw new Error('Docker Hub username is required for publishing');
    }

    try {
      const fullImageName = `${this.dockerHubUsername}/${this.imageName}:${tag}`;
      console.log(`Pushing image ${fullImageName} to Docker Hub...`);

      await this.spawnProcess('docker', ['push', fullImageName], 'push');
      console.log(`Successfully pushed ${fullImageName} to Docker Hub`);
    } catch (error) {
      console.error('Error pushing to Docker Hub:', error);
      throw error;
    }
  }

  /**
   * Asynchronously retrieves a list of published tags for the specified Docker Hub image.
   *
   * @returns A Promise that resolves to a string array of tag names.
   * @throws Error if Docker Hub username is not provided or if an error occurs during the query.
   */
  async listPublishedTags(): Promise<string[]> {
    if (!this.dockerHubUsername) {
      throw new Error('Docker Hub username is required for querying images');
    }

    try {
      console.log(`Querying tags for ${this.dockerHubUsername}/${this.imageName}...`);
      const response = await axios.get(
        `https://hub.docker.com/v2/repositories/${this.dockerHubUsername}/${this.imageName}/tags`
      );

      if (response.data?.results) {
        return response.data.results.map((tag: any) => tag.name);
      }
      return [];
    } catch (error) {
      console.error('Error querying Docker Hub:', error);
      throw error;
    }
  }

  /**
   * Runs the simulator with the specified image.
   *
   * @param {string} image - The image of the simulator to run.
   * @returns {Promise<void>} A Promise that resolves when the simulator has been started successfully, or rejects with an error if there was a problem.
   */
  async runSimulator(image: string): Promise<void> {
    try {
      console.log('Pulling latest simulator image...');
      await execAsync(`docker pull ${image}`);

      console.log('Starting simulator in background...');
      const { stdout } = await execAsync(`docker run -d --rm -p 8090:8090 ${image}`);
      const containerId = stdout.trim();

      console.log('\nSimulator started successfully!');
      console.log(`Container ID: ${containerId}`);
      console.log('\nUseful commands:');
      console.log(`- View logs: docker logs -f ${containerId}`);
      console.log(`- Stop simulator: docker stop ${containerId}`);
      console.log('\nSimulator is running on http://localhost:8090');
    } catch (error) {
      console.error('Error running simulator:', error);
      throw error;
    }
  }

  /**
   * Ensures that the compose directory exists by creating it if it doesn't already exist.
   *
   * @returns {string} The path to the compose directory.
   */
  private ensureComposeDir(): string {
    const composePath = path.resolve(COMPOSE_FILES_DIR);
    if (!fs.existsSync(composePath)) {
      fs.mkdirSync(composePath, { recursive: true });
    }
    return composePath;
  }

  /**
   * Asynchronously builds a compose file based on the provided parameters.
   *
   * @param {string} tag - The tag for the Docker image.
   * @param {string} characterName - The name of the character to be used.
   * @param {string} envFile - The path to the environment file.
   * @param {string} [version="v2"] - The version of the compose file (default is "v2").
   * @returns {Promise<string>} The path to the created compose file.
   * @throws {Error} If `dockerHubUsername` is not defined.
   */
  async buildComposeFile(
    tag: string,
    characterName: string,
    envFile: string,
    version = 'v2'
  ): Promise<string> {
    if (!this.dockerHubUsername) {
      throw new Error('Docker Hub username is required for building compose file');
    }

    // Ensure compose files directory exists
    const composePath = this.ensureComposeDir();

    // Parse env file to get variable names
    const envContent = fs.readFileSync(envFile, 'utf-8');
    const envVars = envContent
      .split('\n')
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => line.trim())
      .filter((line) => line.includes('='))
      .map((line) => {
        const key = line.split('=')[0].trim();
        return `${key}=${key}`; // Just create KEY=KEY format
      });

    // Get base name of character file without extension
    let characterBaseName = '';
    let characterBase64Data = '';
    if (version === 'v1') {
      characterBaseName = path.basename(characterName, path.extname(characterName));
      characterBase64Data = fs.readFileSync(characterName, 'base64');
    } else {
      characterBaseName = characterName;
    }

    // Select template based on version
    const template =
      version === 'v1' ? DOCKER_COMPOSE_ELIZA_V1_TEMPLATE : DOCKER_COMPOSE_ELIZA_V2_TEMPLATE;

    // Create full image name with username
    const fullImageName = `${this.dockerHubUsername}/${this.imageName}`;

    // Compile template with data
    const compiledTemplate = Handlebars.compile(template, { noEscape: true });
    const composeContent = compiledTemplate({
      imageName: fullImageName,
      tag,
      characterName: characterBaseName,
      characterBase64Data: characterBase64Data,
      envVars: envVars.map((env) => env.replace(/=.*/, `=\${${env.split('=')[0]}}`)),
    });

    // Write the docker-compose file with standardized name in the compose directory
    const composeFile = path.join(composePath, `${characterBaseName}-tee-compose.yaml`);
    fs.writeFileSync(composeFile, composeContent, { flag: 'w' });

    console.log(`Docker compose file created at: ${composeFile}`);
    return composeFile;
  }

  /**
   * Asynchronously starts a local environment using the specified compose file and env file.
   *
   * @param {string} composeFile - The path to the docker-compose file.
   * @param {string} envFile - The path to the environment file to pass to docker-compose.
   * @returns {Promise<void>} A Promise that resolves when the local environment has been started successfully.
   */
  async runLocalCompose(composeFile: string, envFile: string): Promise<void> {
    try {
      console.log(`Starting local environment using compose file: ${composeFile}...`);
      // Pass the env file to docker-compose
      await execAsync(`docker-compose --env-file ${path.resolve(envFile)} -f ${composeFile} up -d`);

      console.log('\nLocal environment started successfully!');
      console.log('\nUseful commands:');
      console.log(`- View logs: docker-compose -f ${composeFile} logs -f`);
      console.log(`- Stop services: docker-compose -f ${composeFile} down`);
      console.log(`- Compose file location: ${composeFile}`);
    } catch (error) {
      console.error('Error running local environment:', error);
      throw error;
    }
  }

  /**
   * Asynchronously runs a local instance of the service with the specified tag, character name, environment file, and version.
   *
   * @param {string} tag - The tag for the service.
   * @param {string} characterName - The character name for the service.
   * @param {string} envFile - The environment file for the service.
   * @param {string} [version="v2"] - The version of the service to run (default is "v2").
   * @returns {Promise<void>} A Promise that resolves once the local instance has been successfully started.
   * @throws {Error} If an error occurs while building the compose file or running the local compose.
   */
  async runLocal(
    tag: string,
    characterName: string,
    envFile: string,
    version = 'v2'
  ): Promise<void> {
    try {
      const composeFile = await this.buildComposeFile(tag, characterName, envFile, version);
      await this.runLocalCompose(composeFile, envFile);
    } catch (error) {
      console.error('Error in runLocal:', error);
      throw error;
    }
  }
}

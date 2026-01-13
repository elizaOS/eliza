/**
 * Deployment abstractions
 * Handles Docker and other deployment strategies
 */

import * as fs from "node:fs";
import * as path from "node:path";
import Docker, { type ContainerCreateOptions } from "dockerode";
import * as tar from "tar-stream";
import { z } from "zod";
import { getLogger } from "../utils/log";
import {
  AbstractRuntime,
  type BashAction,
  type BashActionResult,
  type BashInterruptAction,
  type Command,
  type CommandResult,
  type CreateBashSessionRequest,
  type ReadFileRequest,
  type ReadFileResponse,
  type UploadRequest,
  type WriteFileRequest,
} from "./runtime";

// Re-export runtime types for convenience
export {
  AbstractRuntime,
  BashAction,
  BashActionResult,
  BashInterruptAction,
  Command,
  CommandResult,
  CreateBashSessionRequest,
  ReadFileRequest,
  ReadFileResponse,
  UploadRequest,
  WriteFileRequest,
} from "./runtime";

const logger = getLogger("deployment");

/**
 * Abstract deployment interface
 */
export abstract class AbstractDeployment {
  abstract runtime: AbstractRuntime;
  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
}

/**
 * Docker deployment configuration
 */
export const DockerDeploymentConfigSchema = z.object({
  type: z.literal("docker"),
  image: z.string().default("python:3.11"),
  containerName: z.string().optional(),
  pythonStandaloneDir: z.string().default("/root"),
  volumes: z.record(z.string(), z.string()).default(() => ({})),
  environment: z.record(z.string(), z.string()).default(() => ({})),
  network: z.string().optional(),
  removeOnStop: z.boolean().default(true),
  workDir: z.string().default("/root"),
});

export type DockerDeploymentConfig = z.infer<
  typeof DockerDeploymentConfigSchema
>;

// Type aliases for Docker types
type DockerContainer = ReturnType<Docker["getContainer"]>;
type DockerExec = Awaited<ReturnType<DockerContainer["exec"]>>;
type DockerSessionStream = Awaited<ReturnType<DockerExec["start"]>>;

/**
 * Docker runtime implementation
 */
class DockerRuntime extends AbstractRuntime {
  private container?: DockerContainer;
  private sessionStream?: DockerSessionStream;
  private sessionExec?: DockerExec;

  constructor(_docker: Docker) {
    super();
  }

  setContainer(container: DockerContainer): void {
    this.container = container;
  }

  async createSession(request: CreateBashSessionRequest): Promise<void> {
    if (!this.container) {
      throw new Error("Container not started");
    }

    // Start an interactive bash session
    this.sessionExec = await this.container.exec({
      Cmd: ["/bin/bash"],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
    });

    if (!this.sessionExec) {
      throw new Error("Failed to create Docker exec session");
    }

    this.sessionStream = await this.sessionExec.start({
      hijack: true,
      stdin: true,
    });

    if (!this.sessionStream) {
      throw new Error("Failed to start Docker exec session");
    }

    // Execute startup source if provided
    if (request.startupSource) {
      for (const source of request.startupSource) {
        await this.runInSession({
          command: `source ${source}`,
          timeout: request.startupTimeout || 10,
        });
      }
    }
  }

  async runInSession(
    action: BashAction | BashInterruptAction,
  ): Promise<BashActionResult> {
    if ("type" in action && action.type === "interrupt") {
      // Send Ctrl+C to the session
      if (this.sessionStream) {
        this.sessionStream.write("\x03");
      }
      return { output: "", exitCode: 0 };
    }

    if (!this.sessionStream) {
      throw new Error("No session active");
    }

    const bashAction = action as BashAction;
    const command = `${bashAction.command}\n`;
    const timeout = bashAction.timeout || 25;

    return new Promise((resolve) => {
      let output = "";
      // let timeoutHandle: NodeJS.Timeout;

      const dataHandler = (chunk: Buffer) => {
        output += chunk.toString();
      };

      if (!this.sessionStream) {
        throw new Error("Session not created");
      }

      const stream = this.sessionStream;
      stream.on("data", dataHandler);

      // Write command
      stream.write(command);

      // Set timeout
      setTimeout(() => {
        stream.removeListener("data", dataHandler);
        resolve({ output, exitCode: 0 }); // Session commands don't easily provide exit codes
      }, timeout * 1000);

      // Note: In a real implementation, we'd need to parse the output
      // to determine when the command is done and extract exit code
    });
  }

  async execute(command: Command): Promise<CommandResult> {
    if (!this.container) {
      throw new Error("Container not started");
    }

    const exec: DockerExec = (await this.container.exec({
      Cmd: command.shell
        ? ["/bin/bash", "-c", command.command]
        : command.command.split(" "),
      AttachStdout: true,
      AttachStderr: true,
      Env: command.env
        ? Object.entries(command.env).map(([k, v]) => `${k}=${v}`)
        : undefined,
      WorkingDir: command.cwd,
    })) as DockerExec;

    const stream = await exec.start({ hijack: false, stdin: false });

    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];

      stream.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });

      stream.on("end", async () => {
        const output = Buffer.concat(chunks).toString("utf-8");
        const inspectResult = await exec.inspect();
        const exitCode = inspectResult.ExitCode || 0;

        if (command.check && exitCode !== 0) {
          reject(
            new Error(`Command failed with exit code ${exitCode}: ${output}`),
          );
        } else {
          resolve({
            exitCode: exitCode as number,
            stdout: output,
            stderr: "", // Docker combines stdout/stderr in this mode
          });
        }
      });

      stream.on("error", reject);

      // Handle timeout
      if (command.timeout) {
        setTimeout(() => {
          if (stream && typeof stream.destroy === "function") {
            stream.destroy();
          }
          reject(new Error(`Command timeout after ${command.timeout}s`));
        }, command.timeout * 1000);
      }
    });
  }

  async readFile(request: ReadFileRequest): Promise<ReadFileResponse> {
    const command: Command = {
      command: `cat "${request.path}"`,
      shell: true,
    };

    const result = await this.execute(command);

    if (result.exitCode !== 0) {
      throw new Error(`Failed to read file ${request.path}: ${result.stdout}`);
    }

    return { content: result.stdout };
  }

  async writeFile(request: WriteFileRequest): Promise<void> {
    // Create directory if needed
    const dir = path.dirname(request.path);
    if (dir && dir !== "/" && dir !== ".") {
      await this.execute({
        command: `mkdir -p "${dir}"`,
        shell: true,
      });
    }

    // Write file using echo and base64 to handle special characters
    const base64Content = Buffer.from(request.content).toString("base64");
    const result = await this.execute({
      command: `echo "${base64Content}" | base64 -d > "${request.path}"`,
      shell: true,
    });

    if (result.exitCode !== 0) {
      throw new Error(`Failed to write file ${request.path}: ${result.stdout}`);
    }
  }

  async upload(request: UploadRequest): Promise<void> {
    if (!this.container) {
      throw new Error("Container not started");
    }

    // Create a tar stream from the local path
    type TarPack = ReturnType<typeof tar.pack>;
    const pack: TarPack = tar.pack();

    const addToTar = (sourcePath: string, targetPath: string) => {
      const stats = fs.statSync(sourcePath);

      if (stats.isDirectory()) {
        // Recursively add directory contents
        const items = fs.readdirSync(sourcePath);
        for (const item of items) {
          // Skip .git and other hidden files/directories
          if (item.startsWith(".")) {
            continue;
          }

          const itemSource = path.join(sourcePath, item);
          const itemTarget = path.join(targetPath, item);
          addToTar(itemSource, itemTarget);
        }
      } else {
        // Add file to tar
        const content = fs.readFileSync(sourcePath);
        const relativePath = path.relative("/", targetPath);
        pack.entry({ name: relativePath }, content);
      }
    };

    // Add source to tar archive
    const targetName = path.basename(request.targetPath);
    addToTar(request.sourcePath, targetName);

    pack.finalize();

    // Put archive to container at root
    await this.container.putArchive(pack, { path: "/" });
  }
}

/**
 * Docker-based deployment
 */
export class DockerDeployment extends AbstractDeployment {
  private docker: Docker;
  private container?: DockerContainer;
  private config: DockerDeploymentConfig;
  runtime: DockerRuntime;

  constructor(config: DockerDeploymentConfig) {
    super();
    this.config = DockerDeploymentConfigSchema.parse(config);
    this.docker = new Docker();
    this.runtime = new DockerRuntime(this.docker);
  }

  async start(): Promise<void> {
    logger.info(`Starting Docker container with image ${this.config.image}`);

    // Check if image exists, pull if not
    const images = await this.docker.listImages();
    const imageExists = images.some((img) =>
      Array.isArray(img.RepoTags)
        ? img.RepoTags.includes(this.config.image)
        : false,
    );
    if (!imageExists) {
      logger.info(`Pulling image ${this.config.image}`);
      const stream = await this.docker.pull(this.config.image);
      await new Promise<void>((resolve, reject) => {
        this.docker.modem.followProgress(stream, (err, _res) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
    }

    // Create container
    const createOptions: ContainerCreateOptions = {
      Image: this.config.image,
      name: this.config.containerName,
      WorkingDir: this.config.workDir,
      Env: Object.entries(this.config.environment).map(([k, v]) => `${k}=${v}`),
      Tty: true,
      OpenStdin: true,
      StdinOnce: false,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      HostConfig: {
        Binds: Object.entries(this.config.volumes).map(([k, v]) => `${k}:${v}`),
        NetworkMode: this.config.network,
      },
    };

    this.container = await this.docker.createContainer(createOptions);
    await this.container.start();

    // Set container in runtime
    this.runtime.setContainer(this.container);

    logger.info("Docker container started successfully");
  }

  async stop(): Promise<void> {
    if (!this.container) {
      return;
    }

    logger.info("Stopping Docker container");

    try {
      await this.container.stop({ t: 10 });
    } catch (error) {
      logger.warn("Container stop failed, forcing kill", error);
      await this.container.kill();
    }

    if (this.config.removeOnStop) {
      await this.container.remove();
    }

    this.container = undefined;
  }
}

/**
 * Union type for all deployment configurations
 */
export const DeploymentConfigSchema = z.discriminatedUnion("type", [
  DockerDeploymentConfigSchema,
  // Add other deployment types here (e.g., local, kubernetes, etc.)
]);

export type DeploymentConfig = z.infer<typeof DeploymentConfigSchema>;

/**
 * Factory function to create deployment from config
 */
export function getDeployment(config: DeploymentConfig): AbstractDeployment {
  switch (config.type) {
    case "docker":
      return new DockerDeployment(config);
    default:
      throw new Error(`Unknown deployment type: ${config.type}`);
  }
}

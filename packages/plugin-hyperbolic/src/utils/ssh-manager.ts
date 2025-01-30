import { Client, ClientChannel } from 'ssh2';
import { elizaLogger } from "@elizaos/core";
import { readFileSync } from 'node:fs';
import { HyperbolicConfig } from '../environment';

export interface SSHConfig {
  host: string;
  username: string;
  password?: string;
  privateKey?: string;
  privateKeyPath?: string;
  port: number;
}

export interface CommandResult {
  output: string;
  exitCode: number;
}

/**
 * Manages SSH connections and command execution
 */
export class SSHManager {
  private client: Client;
  private channel: ClientChannel | null = null;
  private config: SSHConfig;

  constructor(config: SSHConfig) {
    this.client = new Client();
    this.config = config;
  }

  /**
   * Create SSHManager instance from Hyperbolic configuration
   * @param config Hyperbolic configuration
   * @param host SSH host
   * @param username SSH username
   * @param port SSH port
   */
  static fromConfig(
    config: HyperbolicConfig,
    host: string,
    username: string,
    port = 22
  ): SSHManager {
    if (!config.HYPERBOLIC_SSH_PRIVATE_KEY_PATH) {
      elizaLogger.error('SSH private key path not configured');
      throw new Error('SSH_PRIVATE_KEY_PATH is not set in configuration');
    }

    return new SSHManager({
      host,
      username,
      port,
      privateKeyPath: config.HYPERBOLIC_SSH_PRIVATE_KEY_PATH
    });
  }

  /**
   * Connects to a remote server via SSH
   */
  async connect(): Promise<void> {
    try {
      const config = {
        host: this.config.host,
        username: this.config.username,
        password: this.config.password,
        privateKey: this.config.privateKey || (this.config.privateKeyPath ? readFileSync(this.config.privateKeyPath) : undefined),
        port: this.config.port
      };

      elizaLogger.debug('Initiating SSH connection', {
        host: config.host,
        username: config.username,
        port: config.port
      });

      await new Promise<void>((resolve, reject) => {
        this.client
          .on('ready', () => {
            elizaLogger.debug('SSH connection established');
            resolve();
          })
          .on('error', (err: Error) => {
            elizaLogger.error('SSH connection failed', { error: err.message });
            reject(err);
          })
          .connect(config);
      });
    } catch (error) {
      elizaLogger.error('Failed to establish SSH connection', {
        error: error instanceof Error ? error.message : String(error),
        host: this.config.host
      });
      throw error;
    }
  }

  /**
   * Executes a command on the remote server
   * @param command Command to execute
   * @returns Command result including output and exit code
   */
  async executeCommand(command: string): Promise<CommandResult> {
    if (!this.client) {
      throw new Error('SSH client not initialized');
    }

    try {
      elizaLogger.debug('Executing SSH command', { command });

      return await new Promise<CommandResult>((resolve, reject) => {
        this.client.exec(command, (err, stream) => {
          if (err) {
            elizaLogger.error('Failed to execute command', {
              error: err.message,
              command
            });
            reject(err);
            return;
          }

          let output = '';
          let exitCode: number | null = null;

          stream.on('data', (data: Buffer) => {
            output += data.toString();
          });

          stream.stderr.on('data', (data: Buffer) => {
            output += data.toString();
          });

          stream.on('exit', (code: number) => {
            exitCode = code;
          });

          stream.on('close', () => {
            elizaLogger.debug('Command execution completed', {
              command,
              exitCode
            });
            resolve({
              output,
              exitCode: exitCode ?? -1
            });
          });
        });
      });
    } catch (error) {
      elizaLogger.error('Command execution failed', {
        error: error instanceof Error ? error.message : String(error),
        command
      });
      throw error;
    }
  }

  /**
   * Disconnects from the remote server
   */
  disconnect(): void {
    if (this.channel) {
      this.channel.close();
      this.channel = null;
    }
    if (this.client) {
      elizaLogger.debug('Closing SSH connection');
      this.client.end();
    }
  }

  /**
   * Creates a new SSHManager instance with basic configuration
   * @param host SSH host
   * @param username SSH username
   * @param port SSH port (default: 22)
   * @returns SSHManager instance
   */
  static create(
    host: string,
    username: string,
    port = 22
  ): SSHManager {
    return new SSHManager({
      host,
      username,
      port
    });
  }
}

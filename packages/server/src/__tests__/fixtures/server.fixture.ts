/**
 * TestServerFixture - Server lifecycle management with auto-cleanup
 *
 * Uses TC39 Explicit Resource Management (Symbol.asyncDispose) for guaranteed cleanup.
 * Provides isolated server instances with auto port discovery and database isolation.
 *
 * @example
 * ```typescript
 * describe('My Tests', () => {
 *   it('should work', async () => {
 *     await using server = new TestServerFixture();
 *     const { server: agentServer, url } = await server.setup();
 *
 *     // Use server
 *     const agents = await agentServer.getAllAgents();
 *
 *     // Auto-cleanup on scope exit!
 *   });
 * });
 * ```
 */

import { AgentServer } from '../../index';
import {
  setupTestEnvironment,
  teardownTestEnvironment,
  type EnvironmentSnapshot,
} from '../test-utils/environment';
import { findAvailablePort } from '../helpers/networking';
import { waitForServerReady } from '../helpers/wait';

export interface ServerFixtureOptions {
  /**
   * Specific port to use (if undefined, auto-discovers available port)
   */
  port?: number;

  /**
   * Custom database directory (if undefined, creates isolated test DB)
   */
  dataDir?: string;

  /**
   * Port range for auto-discovery [min, max]
   * @default [5000, 9000]
   */
  portRange?: [number, number];

  /**
   * Timeout in ms to wait for server readiness
   * @default 10000
   */
  readyTimeout?: number;
}

export interface ServerFixtureResult {
  /**
   * The AgentServer instance
   */
  server: AgentServer;

  /**
   * The port the server is listening on
   */
  port: number;

  /**
   * Base URL for HTTP requests
   */
  url: string;

  /**
   * Database directory path
   */
  dbPath: string;
}

/**
 * Test fixture for AgentServer lifecycle management.
 *
 * Handles:
 * - Environment isolation
 * - Port discovery
 * - Database creation
 * - Server startup
 * - Auto-cleanup via Symbol.asyncDispose
 */
export class TestServerFixture {
  private server?: AgentServer;
  private port?: number;
  private envSnapshot?: EnvironmentSnapshot;
  private isSetup = false;

  /**
   * Setup the server with optional configuration
   */
  async setup(options: ServerFixtureOptions = {}): Promise<ServerFixtureResult> {
    if (this.isSetup) {
      throw new Error('Server already setup. Create a new fixture instance.');
    }

    try {
      // Setup isolated environment
      this.envSnapshot = setupTestEnvironment({ isolateDatabase: true });
      process.env.IGNORE_BOOTSTRAP = 'true';

      // Discover or use specified port
      const portRange = options.portRange ?? [5000, 9000];
      this.port = options.port ?? (await findAvailablePort(portRange));

      // Set SERVER_PORT for MessageBusService
      process.env.SERVER_PORT = this.port.toString();

      // Create and start server
      this.server = new AgentServer();

      const dataDir = options.dataDir ?? this.envSnapshot.testDbPath;
      await this.server.start({
        dataDir,
        port: this.port,
      });

      // Wait for server to be ready
      const readyTimeout = options.readyTimeout ?? 10000;
      await waitForServerReady(this.port, readyTimeout);

      this.isSetup = true;

      return {
        server: this.server,
        port: this.port,
        url: `http://localhost:${this.port}`,
        dbPath: dataDir ?? '',
      };
    } catch (error) {
      // Cleanup on setup failure
      await this.cleanup();
      throw error;
    }
  }

  /**
   * Get the server instance (must call setup() first)
   */
  getServer(): AgentServer {
    if (!this.server || !this.isSetup) {
      throw new Error('Server not initialized. Call setup() first.');
    }
    return this.server;
  }

  /**
   * Get the server port (must call setup() first)
   */
  getPort(): number {
    if (!this.port || !this.isSetup) {
      throw new Error('Server not initialized. Call setup() first.');
    }
    return this.port;
  }

  /**
   * Get the server URL (must call setup() first)
   */
  getUrl(): string {
    return `http://localhost:${this.getPort()}`;
  }

  /**
   * Manual cleanup (usually not needed - use `await using` instead)
   */
  async cleanup(): Promise<void> {
    if (this.server) {
      try {
        // Stop all agents first
        const agents = this.server.getAllAgents();
        const agentIds = agents.map((a) => a.agentId);

        if (agentIds.length > 0) {
          await this.server.stopAgents(agentIds);
          // Give agents time to cleanup connections
          await new Promise((resolve) => setTimeout(resolve, 100));
        }

        // Stop HTTP server
        await this.server.stop();
        await new Promise((resolve) => setTimeout(resolve, 500));
      } catch (error) {
        console.warn('Error during server cleanup:', error);
      }

      this.server = undefined;
    }

    // Restore environment (this will delete the test DB directory)
    if (this.envSnapshot) {
      await teardownTestEnvironment(this.envSnapshot);
      this.envSnapshot = undefined;
    }

    this.isSetup = false;
    this.port = undefined;
  }

  /**
   * Symbol.asyncDispose implementation for automatic cleanup
   *
   * Enables `await using` syntax:
   * ```typescript
   * await using server = new TestServerFixture();
   * ```
   */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.cleanup();
  }
}

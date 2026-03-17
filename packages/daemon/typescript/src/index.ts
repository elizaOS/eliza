/**
 * @elizaos/daemon - Cross-platform daemon/service management for Eliza agents.
 *
 * Provides a unified API for managing background services across platforms:
 * - macOS: LaunchAgents (launchd)
 * - Linux: systemd user services
 * - Windows: Scheduled Tasks (schtasks)
 *
 * @example
 * ```typescript
 * import { installService, getServiceManager } from "@elizaos/daemon";
 *
 * // Install a service
 * await installService({
 *   name: "my-eliza-agent",
 *   description: "My Eliza Agent",
 *   command: ["node", "/path/to/agent.js"],
 *   keepAlive: true,
 *   runAtLoad: true,
 * });
 *
 * // Check status
 * const manager = getServiceManager();
 * const runtime = await manager.getRuntime("my-eliza-agent");
 * console.log(`Running: ${runtime.running}, PID: ${runtime.pid}`);
 * ```
 *
 * @module
 */

import { launchdManager } from "./launchd.js";
import { schtasksManager } from "./schtasks.js";
import { systemdManager } from "./systemd.js";
import type {
  Platform,
  ServiceCommand,
  ServiceConfig,
  ServiceManager,
  ServiceResult,
  ServiceRuntime,
} from "./types.js";

// Re-export platform-specific managers for direct access
export { launchdManager } from "./launchd.js";
export { schtasksManager } from "./schtasks.js";
export { systemdManager } from "./systemd.js";
// Re-export types
export type {
  Platform,
  ServiceCommand,
  ServiceConfig,
  ServiceManager,
  ServiceResult,
  ServiceRuntime,
};

/**
 * Get the current platform.
 */
export function getPlatform(): Platform {
  return process.platform as Platform;
}

/**
 * Check if the current platform is supported.
 */
export function isPlatformSupported(): boolean {
  const platform = getPlatform();
  return platform === "darwin" || platform === "linux" || platform === "win32";
}

/**
 * Get the service manager for the current platform.
 *
 * @throws Error if the platform is not supported
 */
export function getServiceManager(): ServiceManager {
  const platform = getPlatform();

  switch (platform) {
    case "darwin":
      return launchdManager;
    case "linux":
      return systemdManager;
    case "win32":
      return schtasksManager;
    default:
      throw new Error(`Unsupported platform: ${platform}`);
  }
}

/**
 * Install a service on the current platform.
 *
 * @param config - Service configuration
 * @returns Result of the installation
 */
export async function installService(
  config: ServiceConfig,
): Promise<ServiceResult> {
  const manager = getServiceManager();
  return manager.install(config);
}

/**
 * Uninstall a service on the current platform.
 *
 * @param name - Service name
 * @returns Result of the uninstallation
 */
export async function uninstallService(name: string): Promise<ServiceResult> {
  const manager = getServiceManager();
  return manager.uninstall(name);
}

/**
 * Start a service on the current platform.
 *
 * @param name - Service name
 * @returns Result of the start operation
 */
export async function startService(name: string): Promise<ServiceResult> {
  const manager = getServiceManager();
  return manager.start(name);
}

/**
 * Stop a service on the current platform.
 *
 * @param name - Service name
 * @returns Result of the stop operation
 */
export async function stopService(name: string): Promise<ServiceResult> {
  const manager = getServiceManager();
  return manager.stop(name);
}

/**
 * Restart a service on the current platform.
 *
 * @param name - Service name
 * @returns Result of the restart operation
 */
export async function restartService(name: string): Promise<ServiceResult> {
  const manager = getServiceManager();
  return manager.restart(name);
}

/**
 * Check if a service is installed on the current platform.
 *
 * @param name - Service name
 * @returns True if the service is installed
 */
export async function isServiceInstalled(name: string): Promise<boolean> {
  const manager = getServiceManager();
  return manager.isInstalled(name);
}

/**
 * Check if a service is running on the current platform.
 *
 * @param name - Service name
 * @returns True if the service is running
 */
export async function isServiceRunning(name: string): Promise<boolean> {
  const manager = getServiceManager();
  return manager.isRunning(name);
}

/**
 * Get service command details.
 *
 * @param name - Service name
 * @returns Service command details or null if not found
 */
export async function getServiceCommand(
  name: string,
): Promise<ServiceCommand | null> {
  const manager = getServiceManager();
  return manager.getCommand(name);
}

/**
 * Get service runtime status.
 *
 * @param name - Service name
 * @returns Service runtime status
 */
export async function getServiceRuntime(name: string): Promise<ServiceRuntime> {
  const manager = getServiceManager();
  return manager.getRuntime(name);
}

/**
 * Install an Eliza agent as a service.
 *
 * This is a convenience function that sets up sensible defaults for Eliza agents.
 *
 * @param options - Agent service options
 * @returns Result of the installation
 */
export async function installAgentService(options: {
  /** Agent name (used as service name) */
  name: string;
  /** Agent description */
  description?: string;
  /** Path to the agent entry point (e.g., index.js) */
  entryPoint: string;
  /** Working directory for the agent */
  workingDirectory?: string;
  /** Node.js executable path (defaults to current process) */
  nodeExecutable?: string;
  /** Additional environment variables */
  environment?: Record<string, string>;
}): Promise<ServiceResult> {
  const nodeExe = options.nodeExecutable || process.execPath;
  const config: ServiceConfig = {
    name: options.name,
    description: options.description || `Eliza Agent: ${options.name}`,
    command: [nodeExe, options.entryPoint],
    workingDirectory: options.workingDirectory,
    environment: options.environment,
    keepAlive: true,
    restartOnFailure: true,
    restartDelay: 5,
    runAtLoad: true,
  };

  return installService(config);
}

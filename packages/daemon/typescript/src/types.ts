/**
 * Cross-platform daemon/service management types.
 */

/** Service configuration for installation */
export interface ServiceConfig {
  /** Unique service name/identifier */
  name: string;
  /** Human-readable description */
  description?: string;
  /** Command to execute (first element is the executable) */
  command: string[];
  /** Working directory for the service */
  workingDirectory?: string;
  /** Environment variables */
  environment?: Record<string, string>;
  /** Auto-restart on failure */
  restartOnFailure?: boolean;
  /** Restart delay in seconds */
  restartDelay?: number;
  /** Keep alive (restart if process exits) */
  keepAlive?: boolean;
  /** Run at system load (boot/login) */
  runAtLoad?: boolean;
}

/** Service runtime status */
export interface ServiceRuntime {
  /** Whether the service is currently running */
  running: boolean;
  /** Process ID if running */
  pid?: number;
  /** Last exit code */
  exitCode?: number;
  /** Service uptime in seconds */
  uptimeSeconds?: number;
  /** Additional platform-specific info */
  platformInfo?: Record<string, unknown>;
}

/** Service command details */
export interface ServiceCommand {
  /** Program arguments */
  programArguments: string[];
  /** Working directory */
  workingDirectory?: string;
  /** Environment variables */
  environment?: Record<string, string>;
  /** Source file path (plist, unit file, etc.) */
  sourcePath?: string;
}

/** Result of a service operation */
export interface ServiceResult {
  success: boolean;
  message?: string;
  error?: string;
}

/** Platform-specific service manager interface */
export interface ServiceManager {
  /** Platform label (LaunchAgent, systemd, Scheduled Task) */
  readonly label: string;
  /** Text shown when service is loaded/enabled */
  readonly loadedText: string;
  /** Text shown when service is not loaded/disabled */
  readonly notLoadedText: string;

  /** Install the service */
  install(config: ServiceConfig): Promise<ServiceResult>;
  /** Uninstall the service */
  uninstall(name: string): Promise<ServiceResult>;
  /** Start the service */
  start(name: string): Promise<ServiceResult>;
  /** Stop the service */
  stop(name: string): Promise<ServiceResult>;
  /** Restart the service */
  restart(name: string): Promise<ServiceResult>;
  /** Check if service is installed/loaded */
  isInstalled(name: string): Promise<boolean>;
  /** Check if service is running */
  isRunning(name: string): Promise<boolean>;
  /** Get service command details */
  getCommand(name: string): Promise<ServiceCommand | null>;
  /** Get service runtime status */
  getRuntime(name: string): Promise<ServiceRuntime>;
}

/** Supported platforms */
export type Platform = "darwin" | "linux" | "win32";

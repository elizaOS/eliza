/**
 * Runtime abstractions deployment
 * Interfaces and types matching SWE-ReX runtime
 */

/**
 * Bash action for running commands in a session
 */
export interface BashAction {
  command: string;
  timeout?: number;
  check?: 'silent' | 'ignore';
}

/**
 * Bash action result
 */
export interface BashActionResult {
  output: string;
  exitCode: number;
}

/**
 * Interrupt action for stopping running commands
 */
export interface BashInterruptAction {
  type: 'interrupt';
}

/**
 * Create bash session request
 */
export interface CreateBashSessionRequest {
  startupSource?: string[];
  startupTimeout?: number;
}

/**
 * Command execution request (non-session)
 */
export interface Command {
  command: string;
  shell?: boolean;
  check?: boolean;
  env?: Record<string, string>;
  cwd?: string;
  timeout?: number;
}

/**
 * Command execution result
 */
export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * File read request
 */
export interface ReadFileRequest {
  path: string;
  encoding?: string;
  errors?: string;
}

/**
 * File read response
 */
export interface ReadFileResponse {
  content: string;
}

/**
 * File write request
 */
export interface WriteFileRequest {
  path: string;
  content: string;
}

/**
 * Upload request for copying files/directories
 */
export interface UploadRequest {
  sourcePath: string;
  targetPath: string;
}

/**
 * Abstract runtime interface
 */
export abstract class AbstractRuntime {
  abstract createSession(request: CreateBashSessionRequest): Promise<void>;
  abstract runInSession(action: BashAction | BashInterruptAction): Promise<BashActionResult>;
  abstract execute(command: Command): Promise<CommandResult>;
  abstract readFile(request: ReadFileRequest): Promise<ReadFileResponse>;
  abstract writeFile(request: WriteFileRequest): Promise<void>;
  abstract upload(request: UploadRequest): Promise<void>;
}

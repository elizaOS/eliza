/**
 * Helper classes for test-run-single.test.ts
 */

import { 
  AbstractDeployment,
  AbstractRuntime,
  BashAction,
  BashActionResult,
  BashInterruptAction,
  Command,
  CommandResult,
  CreateBashSessionRequest,
  ReadFileRequest,
  ReadFileResponse,
  WriteFileRequest,
  UploadRequest,
} from '../src/environment/deployment';

/**
 * Mock runtime for testing
 */
export class MockRuntime extends AbstractRuntime {
  private files: Map<string, string> = new Map();
  private sessionOutput: string = '';

  async createSession(_request: CreateBashSessionRequest): Promise<void> {
    // Mock implementation
  }

  async runInSession(action: BashAction | BashInterruptAction): Promise<BashActionResult> {
    if ('type' in action && action.type === 'interrupt') {
      return { output: '', exitCode: 0 };
    }

    const bashAction = action as BashAction;

    // Mock some basic commands
    if (bashAction.command.startsWith('echo ')) {
      const text = bashAction.command.substring(5).replace(/['"]/g, '');
      return { output: text + '\n', exitCode: 0 };
    }

    if (bashAction.command === 'ls') {
      return { output: 'file1\nfile2\n', exitCode: 0 };
    }

    if (bashAction.command.startsWith('sleep ')) {
      const seconds = parseFloat(bashAction.command.substring(6));
      if (bashAction.timeout && bashAction.timeout < seconds) {
        throw new Error('Command timeout');
      }
      return { output: '', exitCode: 0 };
    }

    return { output: this.sessionOutput, exitCode: 0 };
  }

  async execute(_command: Command): Promise<CommandResult> {
    return { exitCode: 0, stdout: '', stderr: '' };
  }

  async readFile(request: ReadFileRequest): Promise<ReadFileResponse> {
    const content = this.files.get(request.path) || '';
    return { content };
  }

  async writeFile(request: WriteFileRequest): Promise<void> {
    this.files.set(request.path, request.content);
  }

  async upload(_request: UploadRequest): Promise<void> {
    // Mock implementation
  }
}

/**
 * Mock deployment for testing
 */
export class MockDeployment extends AbstractDeployment {
  runtime: MockRuntime;

  constructor() {
    super();
    this.runtime = new MockRuntime();
  }

  async start(): Promise<void> {
    // Mock implementation
  }

  async stop(): Promise<void> {
    // Mock implementation
  }
}

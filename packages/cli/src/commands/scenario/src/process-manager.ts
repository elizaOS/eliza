/**
 * Process Manager for tracking and cleaning up child processes in matrix runs
 */

export interface ProcessInfo {
  pid: number;
  runId: string;
  type: 'agent-server' | 'scenario-runner';
  startTime: Date;
  port?: number;
}

export class ProcessManager {
  private processes = new Map<string, ProcessInfo>();
  private signalHandlersRegistered = false;

  /**
   * Register a process for tracking
   */
  registerProcess(runId: string, pid: number, type: ProcessInfo['type'], port?: number): void {
    console.log(
      `🔧 [ProcessManager] Registering process ${pid} for runId: ${runId} (type: ${type})`
    );

    this.processes.set(runId, {
      pid,
      runId,
      type,
      startTime: new Date(),
      port,
    });

    // Register signal handlers on first process
    if (!this.signalHandlersRegistered) {
      this.registerSignalHandlers();
      this.signalHandlersRegistered = true;
    }
  }

  /**
   * Unregister a process when it completes normally
   */
  unregisterProcess(runId: string): void {
    const processInfo = this.processes.get(runId);
    if (processInfo) {
      console.log(
        `🔧 [ProcessManager] Unregistering process ${processInfo.pid} for runId: ${runId}`
      );
      this.processes.delete(runId);
    }
  }

  /**
   * Get all registered processes
   */
  getProcesses(): Map<string, ProcessInfo> {
    return new Map(this.processes);
  }

  /**
   * Check if a process is still running
   */
  isProcessRunning(pid: number): boolean {
    try {
      // Sending signal 0 checks if process exists without killing it
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Gracefully terminate a specific process
   */
  async terminateProcess(runId: string, timeout: number = 5000): Promise<boolean> {
    const processInfo = this.processes.get(runId);
    if (!processInfo) {
      console.log(`🔧 [ProcessManager] No process found for runId: ${runId}`);
      return true;
    }

    const { pid } = processInfo;
    console.log(`🔧 [ProcessManager] Terminating process ${pid} for runId: ${runId}`);

    if (!this.isProcessRunning(pid)) {
      console.log(`🔧 [ProcessManager] Process ${pid} already terminated`);
      this.unregisterProcess(runId);
      return true;
    }

    try {
      // First try graceful termination
      process.kill(pid, 'SIGTERM');

      // Wait for graceful termination
      const startTime = Date.now();
      while (Date.now() - startTime < timeout) {
        if (!this.isProcessRunning(pid)) {
          console.log(`🔧 [ProcessManager] Process ${pid} terminated gracefully`);
          this.unregisterProcess(runId);
          return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      // Force kill if graceful termination failed
      console.log(`🔧 [ProcessManager] Force killing process ${pid} after timeout`);
      process.kill(pid, 'SIGKILL');
      this.unregisterProcess(runId);
      return true;
    } catch (error) {
      console.log(`🔧 [ProcessManager] Failed to terminate process ${pid}:`, error);
      return false;
    }
  }

  /**
   * Terminate all registered processes
   */
  async terminateAllProcesses(timeout: number = 10000): Promise<void> {
    const processes = Array.from(this.processes.keys());
    console.log(`🔧 [ProcessManager] Terminating ${processes.length} processes`);

    if (processes.length === 0) {
      return;
    }

    // Terminate all processes in parallel
    const terminationPromises = processes.map((runId) =>
      this.terminateProcess(runId, timeout / processes.length)
    );

    await Promise.allSettled(terminationPromises);

    // Final cleanup - force kill any remaining processes
    for (const [_, processInfo] of this.processes.entries()) {
      if (this.isProcessRunning(processInfo.pid)) {
        console.log(`🔧 [ProcessManager] Force killing remaining process ${processInfo.pid}`);
        try {
          process.kill(processInfo.pid, 'SIGKILL');
        } catch (error) {
          console.log(`🔧 [ProcessManager] Failed to force kill ${processInfo.pid}:`, error);
        }
      }
    }

    this.processes.clear();
  }

  /**
   * Register signal handlers to cleanup on exit
   */
  private registerSignalHandlers(): void {
    console.log(`🔧 [ProcessManager] Registering signal handlers`);

    const handleExit = async (signal: string) => {
      console.log(`🔧 [ProcessManager] Received ${signal}, cleaning up processes...`);
      await this.terminateAllProcesses();
      console.log(`🔧 [ProcessManager] Process cleanup completed`);
      process.exit(0);
    };

    // Handle various exit signals
    process.on('SIGINT', () => handleExit('SIGINT'));
    process.on('SIGTERM', () => handleExit('SIGTERM'));
    process.on('SIGUSR1', () => handleExit('SIGUSR1'));
    process.on('SIGUSR2', () => handleExit('SIGUSR2'));

    // Handle uncaught exceptions
    process.on('uncaughtException', async (error) => {
      console.error(`🔧 [ProcessManager] Uncaught exception:`, error);
      await this.terminateAllProcesses();
      process.exit(1);
    });

    process.on('unhandledRejection', async (reason, promise) => {
      console.error(`🔧 [ProcessManager] Unhandled rejection at:`, promise, 'reason:', reason);
      await this.terminateAllProcesses();
      process.exit(1);
    });
  }

  /**
   * Get summary of managed processes
   */
  getSummary(): { total: number; byType: Record<string, number>; oldestProcess?: ProcessInfo } {
    const processes = Array.from(this.processes.values());
    const byType: Record<string, number> = {};
    let oldestProcess: ProcessInfo | undefined;

    for (const proc of processes) {
      byType[proc.type] = (byType[proc.type] || 0) + 1;

      if (!oldestProcess || proc.startTime < oldestProcess.startTime) {
        oldestProcess = proc;
      }
    }

    return {
      total: processes.length,
      byType,
      oldestProcess,
    };
  }
}

// Global process manager instance
export const processManager = new ProcessManager();

/**
 * Progress management for batch runs
 */

// import * as path from 'path';  // Currently unused
import * as fs from 'fs';
import * as yaml from 'js-yaml';

/**
 * Interface for tracking instance statistics
 * Currently unused but may be needed in future
 */
/* interface InstanceStats {
  exitStatus: string | null;
  result?: string;
  cost?: number;
  apiCalls?: number;
} */

/**
 * Progress manager for batch runs
 */
interface SpinnerTask {
  status: string;
  startTime: number;
}

export class RunBatchProgressManager {
  private spinnerTasks: Map<string, SpinnerTask> = new Map();
  // private lock: boolean = false;  // Currently unused
  private instancesByExitStatus: Map<string | null, string[]> = new Map();
  // private mainProgressBar: any;  // Currently unused
  // private taskProgressBar: any;  // Currently unused
  // private mainTaskId: any;  // Currently unused
  private yamlReportPath?: string;
  // private numInstances: number;  // Currently unused

  constructor(_numInstances: number, yamlReportPath?: string) {
    // this.numInstances = numInstances;  // Currently unused
    this.yamlReportPath = yamlReportPath;

    // Note: In a real implementation, we'd integrate with a progress library
    // like ora or cli-progress. For now, we'll use console logging
  }

  get nCompleted(): number {
    let total = 0;
    for (const instances of this.instancesByExitStatus.values()) {
      total += instances.length;
    }
    return total;
  }

  updateExitStatusTable(): void {
    // Update the exit status table display
    // In a real implementation, this would update a terminal UI
    const sorted = Array.from(this.instancesByExitStatus.entries()).sort((a, b) => b[1].length - a[1].length);

    console.log('\n=== Exit Status Summary ===');
    for (const [status, instances] of sorted) {
      const instancesStr = this.shortenStr(instances.reverse().join(', '), 55);
      console.log(`${status}: ${instances.length} - ${instancesStr}`);
    }
  }

  private shortenStr(s: string, maxLen: number, shortenLeft: boolean = false): string {
    if (!shortenLeft) {
      if (s.length > maxLen) {
        return s.substring(0, maxLen - 3) + '...';
      }
    } else {
      if (s.length > maxLen) {
        return '...' + s.substring(s.length - maxLen + 3);
      }
    }
    return s.padEnd(maxLen);
  }

  updateInstanceStatus(instanceId: string, message: string): void {
    // Update instance status in the progress display
    console.log(`[${instanceId}] ${message}`);
  }

  onInstanceStart(instanceId: string): void {
    // Mark instance as started
    this.spinnerTasks.set(instanceId, {
      status: 'Task initialized',
      startTime: Date.now(),
    });
  }

  onInstanceEnd(instanceId: string, exitStatus: string | null): void {
    // Mark instance as completed
    if (!this.instancesByExitStatus.has(exitStatus)) {
      this.instancesByExitStatus.set(exitStatus, []);
    }
    this.instancesByExitStatus.get(exitStatus)!.push(instanceId);

    this.spinnerTasks.delete(instanceId);
    this.updateExitStatusTable();

    if (this.yamlReportPath) {
      this.saveOverviewDataYaml(this.yamlReportPath);
    }
  }

  onUncaughtException(instanceId: string, exception: Error): void {
    this.onInstanceEnd(instanceId, `Uncaught ${exception.constructor.name}`);
  }

  printReport(): void {
    console.log('\n=== Final Report ===');
    for (const [status, instances] of this.instancesByExitStatus.entries()) {
      console.log(`${status}: ${instances.length}`);
      for (const instance of instances) {
        console.log(`  ${instance}`);
      }
    }
  }

  private getOverviewData(): Record<string, any> {
    const instancesByStatus: Record<string, string[]> = {};
    for (const [status, instances] of this.instancesByExitStatus.entries()) {
      instancesByStatus[status || 'unknown'] = instances;
    }

    return {
      instances_by_exit_status: instancesByStatus,
      total_cost: 0, // Would need to track this properly
    };
  }

  private saveOverviewDataYaml(filePath: string): void {
    const data = this.getOverviewData();
    fs.writeFileSync(filePath, yaml.dump(data, { indent: 4 }));
  }
}

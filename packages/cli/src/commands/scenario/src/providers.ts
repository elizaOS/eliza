import { Scenario } from './schema';
import { TrajectoryStep } from './TrajectoryReconstructor';

/**
 * The result of executing the 'run' block in a scenario.
 */
export interface ExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  // A map of all file paths to their string content within the execution environment.
  files: Record<string, string>;
  // Timing information for execution
  startedAtMs?: number; // epoch ms
  endedAtMs?: number; // epoch ms
  durationMs?: number; // derived convenience
  // Agent trajectory logging (Ticket #5785)
  trajectory?: TrajectoryStep[];
}

/**
 * Defines the contract for an environment where a scenario can be executed.
 */
export interface EnvironmentProvider {
  /**
   * Prepares the environment for the run. This includes creating temporary
   * directories and seeding the file system.
   * @param scenario The full scenario definition object.
   */
  setup(scenario: Scenario): Promise<void>;
  /**
   * Executes all run steps of the scenario.
   * @param scenario The full scenario definition object.
   */
  run(scenario: Scenario): Promise<ExecutionResult[]>;
  /**
   * Cleans up any resources created during the setup and run phases.
   */
  teardown(): Promise<void>;
}

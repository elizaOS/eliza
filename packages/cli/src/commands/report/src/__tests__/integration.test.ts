/**
 * Report Generation Integration Tests
 *
 * End-to-end integration tests that verify the complete workflow of the
 * elizaos report generate command, from reading input files to generating
 * the final report.json output.
 *
 * Required by ticket #5787 - Integration Testing Requirements.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { executeGenerateCommand } from '../../generate';
import { ScenarioRunResult } from '../../../scenario/src/schema';
import { ReportData } from '../report-schema';

describe('Report Generation Integration', () => {
  let testDir: string;
  let inputDir: string;
  let outputPath: string;

  beforeEach(async () => {
    // Create a temporary directory for test files
    testDir = await fs.mkdtemp(join(tmpdir(), 'elizaos-report-test-'));
    inputDir = join(testDir, 'matrix-output');
    outputPath = join(testDir, 'test-report.json');

    await fs.mkdir(inputDir, { recursive: true });
  });

  afterEach(async () => {
    // Clean up test directory
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  test('should process valid matrix run data and generate comprehensive report', async () => {
    // Create mock run data files
    const mockRuns: ScenarioRunResult[] = [
      {
        run_id: 'run-001',
        matrix_combination_id: 'combo-1',
        parameters: {
          'character.llm.model': 'gpt-4',
          'character.temperature': 0.7,
        },
        metrics: {
          execution_time_seconds: 12.5,
          llm_calls: 3,
          total_tokens: 1500,
        },
        final_agent_response: 'Test response 1',
        evaluations: [
          {
            evaluator_type: 'llm_judge',
            success: true,
            summary: 'Excellent response formatting',
            details: { capability: 'Format Response', score: 0.95, feedback: 'Excellent format' },
          },
          {
            evaluator_type: 'llm_judge',
            success: true,
            summary: 'Good answer quality',
            details: { capability: 'Answer Quality', score: 0.88, feedback: 'Good quality' },
          },
        ],
        trajectory: [
          { type: 'thought', timestamp: '2023-01-01T10:00:00Z', content: 'analyzing request' },
          { type: 'action', timestamp: '2023-01-01T10:00:01Z', content: 'search_github' },
          { type: 'observation', timestamp: '2023-01-01T10:00:02Z', content: 'found results' },
        ],
        error: null,
      },
      {
        run_id: 'run-002',
        matrix_combination_id: 'combo-2',
        parameters: {
          'character.llm.model': 'gpt-3.5-turbo',
          'character.temperature': 0.7,
        },
        metrics: {
          execution_time_seconds: 8.2,
          llm_calls: 2,
          total_tokens: 1200,
        },
        final_agent_response: 'Test response 2',
        evaluations: [
          {
            evaluator_type: 'llm_judge',
            success: true,
            summary: 'Good response formatting',
            details: { capability: 'Format Response', score: 0.92, feedback: 'Good format' },
          },
          {
            evaluator_type: 'llm_judge',
            success: false,
            summary: 'Answer quality needs improvement',
            details: { capability: 'Answer Quality', score: 0.65, feedback: 'Needs improvement' },
          },
        ],
        trajectory: [
          { type: 'thought', timestamp: '2023-01-01T10:05:00Z', content: 'processing query' },
          { type: 'action', timestamp: '2023-01-01T10:05:01Z', content: 'direct_response' },
        ],
        error: null,
      },
      {
        run_id: 'run-003',
        matrix_combination_id: 'combo-1',
        parameters: {
          'character.llm.model': 'gpt-4',
          'character.temperature': 0.9,
        },
        metrics: {
          execution_time_seconds: 15.8,
          llm_calls: 4,
          total_tokens: 2000,
        },
        // final_agent_response is optional for failed runs
        evaluations: [],
        trajectory: [],
        error: 'Timeout during execution',
      },
    ];

    // Write mock run files
    for (let i = 0; i < mockRuns.length; i++) {
      const fileName = `run-${String(i + 1).padStart(3, '0')}.json`;
      const filePath = join(inputDir, fileName);
      await fs.writeFile(filePath, JSON.stringify(mockRuns[i], null, 2));
    }

    // Execute the report generation command
    await executeGenerateCommand(inputDir, { outputPath });

    // Verify the output file was created in the organized structure
    // The organized reports create a timestamped subdirectory
    const outputDir = outputPath; // Keep the full path including .json extension
    const runDirs = await fs.readdir(outputDir);
    const runDir = runDirs
      .filter((dir) => dir.startsWith('run-'))
      .sort()
      .pop();

    expect(runDir).toBeDefined();

    const runPath = join(outputDir, runDir!);
    const actualReportPath = join(runPath, 'report.json');

    const reportExists = await fs
      .access(actualReportPath)
      .then(() => true)
      .catch(() => false);
    expect(reportExists).toBe(true);

    // Read and parse the generated report
    const reportContent = await fs.readFile(actualReportPath, 'utf8');
    const reportData: ReportData = JSON.parse(reportContent);

    // Verify report structure and content
    expect(reportData.metadata).toBeDefined();
    expect(reportData.metadata.input_directory).toBe(inputDir);
    expect(reportData.metadata.processed_files).toBe(3);
    expect(reportData.metadata.skipped_files).toBe(0);

    // Verify summary statistics
    expect(reportData.summary_stats.total_runs).toBe(3);
    expect(reportData.summary_stats.total_failed_runs).toBe(1);
    expect(reportData.summary_stats.overall_success_rate).toBeCloseTo(0.67, 2); // 2/3

    // Verify parameter grouping
    expect(reportData.results_by_parameter['character.llm.model']).toBeDefined();
    expect(reportData.results_by_parameter['character.llm.model']['gpt-4']).toBeDefined();
    expect(reportData.results_by_parameter['character.llm.model']['gpt-3.5-turbo']).toBeDefined();

    const gpt4Stats = reportData.results_by_parameter['character.llm.model']['gpt-4'];
    expect(gpt4Stats.total_runs).toBe(2);
    expect(gpt4Stats.total_failed_runs).toBe(1);

    const gpt35Stats = reportData.results_by_parameter['character.llm.model']['gpt-3.5-turbo'];
    expect(gpt35Stats.total_runs).toBe(1);
    expect(gpt35Stats.total_failed_runs).toBe(0);

    // Verify trajectory analysis
    expect(reportData.common_trajectories.length).toBeGreaterThan(0);
    const mainTrajectory = reportData.common_trajectories.find(
      (t) => t.sequence.join(',') === 'thought,action,observation'
    );
    expect(mainTrajectory).toBeDefined();
    expect(mainTrajectory!.count).toBe(1);

    // Verify capability success rates
    expect(reportData.summary_stats.capability_success_rates['Format Response']).toBe(1.0); // 2/2
    expect(reportData.summary_stats.capability_success_rates['Answer Quality']).toBe(0.5); // 1/2

    // Verify raw results are preserved
    expect(reportData.raw_results).toHaveLength(3);
  });

  test('should handle directory with no valid run files', async () => {
    // Create some invalid files
    await fs.writeFile(join(inputDir, 'invalid.json'), '{ invalid json }');
    await fs.writeFile(join(inputDir, 'not-a-run.json'), '{"not": "a run file"}');

    // Should throw an error for no valid run files (can be either message depending on if files exist)
    await expect(executeGenerateCommand(inputDir, { outputPath })).rejects.toThrow();
  });

  test('should gracefully handle malformed JSON files', async () => {
    // Create one valid run and one malformed file
    const validRun: ScenarioRunResult = {
      run_id: 'run-001',
      matrix_combination_id: 'combo-1',
      parameters: { 'test.param': 'value' },
      metrics: { execution_time_seconds: 10, llm_calls: 1, total_tokens: 500 },
      final_agent_response: 'Test response',
      evaluations: [
        {
          evaluator_type: 'test_evaluator',
          success: true,
          summary: 'Test passed successfully',
          details: { capability: 'Test', score: 1.0, feedback: 'Good' },
        },
      ],
      trajectory: [{ type: 'thought', timestamp: '2023-01-01T10:00:00Z', content: 'thinking' }],
      error: null,
    };

    await fs.writeFile(join(inputDir, 'run-001.json'), JSON.stringify(validRun));
    await fs.writeFile(join(inputDir, 'run-002.json'), '{ malformed json content');

    // Should process the valid file and skip the malformed one
    await executeGenerateCommand(inputDir, { outputPath });

    // The organized reports create a timestamped subdirectory
    const outputDir = outputPath; // Keep the full path including .json extension
    const runDirs = await fs.readdir(outputDir);
    const runDir = runDirs
      .filter((dir) => dir.startsWith('run-'))
      .sort()
      .pop();

    expect(runDir).toBeDefined();

    const runPath = join(outputDir, runDir!);
    const actualReportPath = join(runPath, 'report.json');

    const reportContent = await fs.readFile(actualReportPath, 'utf8');
    const reportData: ReportData = JSON.parse(reportContent);

    expect(reportData.metadata.processed_files).toBe(1);
    expect(reportData.metadata.skipped_files).toBe(1);
    expect(reportData.summary_stats.total_runs).toBe(1);
  });

  test('should error on non-existent input directory', async () => {
    const nonExistentDir = join(testDir, 'does-not-exist');

    await expect(executeGenerateCommand(nonExistentDir, { outputPath })).rejects.toThrow(
      `Input directory not found: ${nonExistentDir}`
    );
  });

  test('should use default output path when not specified', async () => {
    // Create a simple valid run file
    const validRun: ScenarioRunResult = {
      run_id: 'run-001',
      matrix_combination_id: 'combo-1',
      parameters: { 'test.param': 'value' },
      metrics: { execution_time_seconds: 5, llm_calls: 1, total_tokens: 300 },
      final_agent_response: 'Test',
      evaluations: [],
      trajectory: [],
      error: null,
    };

    await fs.writeFile(join(inputDir, 'run-001.json'), JSON.stringify(validRun));

    // Execute without specifying output path
    await executeGenerateCommand(inputDir, {});

    // Should create organized reports in the default location (scenario logs)
    const defaultOutputDir = join(process.cwd(), 'packages/cli/src/commands/scenario/_logs_');

    // Find the most recent run directory by checking timestamps
    const runDirs = await fs.readdir(defaultOutputDir);
    const runDirNames = runDirs.filter((dir) => dir.startsWith('run-'));

    // Sort by timestamp (newest first) and take the first one
    runDirNames.sort((a, b) => {
      const timestampA = a.replace('run-', '').replace(/_/g, 'T').replace(/-/g, ':');
      const timestampB = b.replace('run-', '').replace(/_/g, 'T').replace(/-/g, ':');
      return new Date(timestampB).getTime() - new Date(timestampA).getTime();
    });

    const runDir = runDirNames[0];
    expect(runDir).toBeDefined();

    const runPath = join(defaultOutputDir, runDir);
    const reportPath = join(runPath, 'report.json');

    const reportExists = await fs
      .access(reportPath)
      .then(() => true)
      .catch(() => false);
    expect(reportExists).toBe(true);

    const reportContent = await fs.readFile(reportPath, 'utf8');
    const reportData: ReportData = JSON.parse(reportContent);
    expect(reportData.summary_stats.total_runs).toBe(1);

    // Clean up the generated run directory
    await fs.rm(runPath, { recursive: true, force: true });
  });

  test('should create output directory if it does not exist', async () => {
    // Create a valid run file
    const validRun: ScenarioRunResult = {
      run_id: 'run-001',
      matrix_combination_id: 'combo-1',
      parameters: { 'test.param': 'value' },
      metrics: { execution_time_seconds: 7, llm_calls: 2, total_tokens: 400 },
      final_agent_response: 'Response',
      evaluations: [],
      trajectory: [],
      error: null,
    };

    await fs.writeFile(join(inputDir, 'run-001.json'), JSON.stringify(validRun));

    // Use an output path in a non-existent directory
    const deepOutputDir = join(testDir, 'reports', 'nested', 'deep');
    const deepOutputPath = join(deepOutputDir, 'report.json');

    await executeGenerateCommand(inputDir, { outputPath: deepOutputPath });

    // Verify the file was created and directory structure was created
    // The organized reports create a timestamped subdirectory
    const outputDir = deepOutputPath; // Keep the full path including .json extension
    const runDirs = await fs.readdir(outputDir);
    const runDir = runDirs
      .filter((dir) => dir.startsWith('run-'))
      .sort()
      .pop();

    expect(runDir).toBeDefined();

    const runPath = join(outputDir, runDir!);
    const actualReportPath = join(runPath, 'report.json');

    const reportExists = await fs
      .access(actualReportPath)
      .then(() => true)
      .catch(() => false);
    expect(reportExists).toBe(true);

    const reportContent = await fs.readFile(actualReportPath, 'utf8');
    const reportData: ReportData = JSON.parse(reportContent);
    expect(reportData.summary_stats.total_runs).toBe(1);
  });
});

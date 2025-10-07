/**
 * Report Generate Command Implementation
 *
 * This module implements the 'elizaos report generate' subcommand that processes
 * raw JSON outputs from Scenario Matrix runs and generates comprehensive reports.
 *
 * Required by ticket #5787 - CLI Command Registration and Implementation.
 */

import { Command } from 'commander';
import { promises as fs, existsSync } from 'fs';
import { join, resolve } from 'path';
import { glob } from 'glob';
import { AnalysisEngine } from './src/analysis-engine';
import { ScenarioRunResult, ScenarioRunResultSchema, TrajectoryStep } from '../scenario/src/schema';
import { MatrixConfig } from '../scenario/src/matrix-schema';
import { MatrixRunResult } from '../scenario/src/matrix-orchestrator';
import { ReportData, ReportDataSchema } from './src/report-schema';
import { generatePerformanceReportPdf } from './src/pdf-generator';

export interface GenerateCommandOptions {
  outputPath?: string;
  format?: string;
}

/**
 * Transform MatrixRunResult to ScenarioRunResult format for report processing
 */
function transformMatrixRunResultToScenarioRunResult(
  matrixResult: MatrixRunResult
): ScenarioRunResult {
  // Extract trajectory from scenarioResult.executionResults if available
  let trajectory: TrajectoryStep[] = [];
  let evaluations: any[] = [];
  let finalResponse = '';

  // Handle successful runs with scenarioResult
  const scenarioResult = matrixResult.scenarioResult as any;
  if (scenarioResult && scenarioResult.executionResults) {
    const firstExecutionResult = scenarioResult.executionResults[0];
    if (firstExecutionResult) {
      // Extract trajectory
      if (firstExecutionResult.trajectory) {
        trajectory = firstExecutionResult.trajectory.map(
          (step: any): TrajectoryStep => ({
            type: step.type,
            timestamp: step.timestamp,
            content: step.content || '', // Provide default empty string if content is missing
          })
        );
      }

      // Extract final response
      finalResponse = firstExecutionResult.stdout || '';
    }
  }

  // Extract evaluations from scenarioResult
  if (scenarioResult && scenarioResult.evaluations) {
    // Keep enhanced evaluation results in their original format - ScenarioRunResult expects EnhancedEvaluationResult[]
    evaluations = scenarioResult.evaluations.filter((evaluation: any) => {
      // Only include evaluations that have the expected enhanced format
      return (
        evaluation &&
        typeof evaluation.evaluator_type === 'string' &&
        typeof evaluation.success === 'boolean' &&
        typeof evaluation.summary === 'string' &&
        evaluation.details !== undefined
      );
    });
  }

  // Calculate LLM calls from trajectory data
  let llmCallCount = 0;
  if (trajectory.length > 0) {
    // Count LLM-generated thoughts and replies
    llmCallCount = trajectory.filter(
      (step) =>
        step.type === 'thought' ||
        (step.type === 'action' &&
          typeof step.content === 'object' &&
          step.content.name === 'REPLY') ||
        (step.type === 'observation' &&
          typeof step.content === 'string' &&
          step.content.includes('Generated reply:'))
    ).length;

    // At minimum, we know there was at least 1 LLM call if we have trajectory steps
    if (llmCallCount === 0 && trajectory.length > 0) {
      llmCallCount = 1;
    }
  }

  // Transform metrics to expected format - handle both successful and failed runs
  const baseMetrics = matrixResult.metrics || { memoryUsage: 0, diskUsage: 0, tokenCount: 0 };
  const transformedMetrics = {
    execution_time_seconds: matrixResult.duration / 1000, // Convert ms to seconds
    llm_calls: llmCallCount, // Use calculated LLM call count from trajectory
    total_tokens: baseMetrics.tokenCount || 0,
    // Copy any additional numeric metrics, excluding specific fields
    ...Object.fromEntries(
      Object.entries(baseMetrics).filter(
        ([key, value]) =>
          !['tokenCount', 'memoryUsage', 'diskUsage', 'cpuUsage'].includes(key) &&
          typeof value === 'number'
      )
    ),
  };

  return {
    run_id: matrixResult.runId,
    matrix_combination_id: matrixResult.combinationId,
    parameters: matrixResult.parameters,
    metrics: transformedMetrics,
    final_agent_response: finalResponse,
    evaluations: evaluations,
    trajectory: trajectory,
    error: matrixResult.error || null,
  };
}

export interface DataIngestionResult {
  validRuns: ScenarioRunResult[];
  matrixConfig: MatrixConfig;
  fileStats: {
    processed: number;
    skipped: number;
    errors: string[];
  };
}

/**
 * Create and configure the 'generate' subcommand
 */
export function createGenerateCommand(): Command {
  const command = new Command('generate')
    .description('Generate a comprehensive report from scenario matrix run data')
    .argument('<input_dir>', 'Directory containing run-*.json files from a matrix execution')
    .option(
      '--output-path <path>',
      'Path where the report file will be saved. When no format is specified, creates timestamped folder with all formats.'
    )
    .option(
      '--format <format>',
      'Output format: json, html, pdf, or all. If not specified, generates all formats in organized folder structure.'
    )
    .action(async (inputDir: string, options: GenerateCommandOptions) => {
      try {
        await executeGenerateCommand(inputDir, options);
      } catch (error) {
        console.error(
          '❌ Report generation failed:',
          error instanceof Error ? error.message : error
        );
        process.exit(1);
      }
    });

  return command;
}

/**
 * Main execution logic for the generate command
 */
export async function executeGenerateCommand(
  inputDir: string,
  options: GenerateCommandOptions
): Promise<void> {
  // Resolve input directory path
  const resolvedInputDir = resolve(inputDir);

  // Validate input directory exists
  await validateInputDirectory(resolvedInputDir);

  console.log(`🔍 Processing matrix run data from: ${resolvedInputDir}`);

  // Ingest and validate all run data
  const { validRuns, matrixConfig, fileStats } = await ingestRunData(resolvedInputDir);

  // Report file processing stats
  console.log(`📊 Data ingestion complete:`);
  console.log(`   • Valid runs processed: ${fileStats.processed}`);
  console.log(`   • Files skipped: ${fileStats.skipped}`);
  if (fileStats.errors.length > 0) {
    console.log(`   • Errors encountered: ${fileStats.errors.length}`);
    fileStats.errors.forEach((error) => console.log(`     - ${error}`));
  }

  if (validRuns.length === 0) {
    throw new Error('No valid run files found in the input directory');
  }

  // Generate report using the AnalysisEngine
  console.log(`⚙️  Analyzing ${validRuns.length} runs...`);
  const analysisEngine = new AnalysisEngine();
  const reportData = analysisEngine.processRunResults(validRuns, matrixConfig, resolvedInputDir, {
    processed: fileStats.processed,
    skipped: fileStats.skipped,
  });

  // Validate the generated report data
  try {
    ReportDataSchema.parse(reportData);
  } catch (validationError) {
    console.warn('⚠️  Generated report data failed schema validation:', validationError);
  }

  // Determine output behavior based on format option
  const format = options.format;

  if (!format || format === 'all') {
    // Default behavior: Generate all formats in organized timestamped folder
    await generateOrganizedReports(reportData, resolvedInputDir, options.outputPath);
  } else {
    // Specific format requested: Generate single format
    await generateSingleFormatReport(reportData, format, resolvedInputDir, options.outputPath);
  }
}

/**
 * Generate all report formats in an organized timestamped folder structure
 */
async function generateOrganizedReports(
  reportData: ReportData,
  _inputDir: string,
  customOutputPath?: string
): Promise<void> {
  // Create timestamped run folder
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const runId = `run-${timestamp}`;

  // Use custom output path or default to scenario logs subfolder
  const baseOutputDir = customOutputPath || join(__dirname, '..', 'scenario', '_logs_');
  const runDir = join(baseOutputDir, runId);

  // Ensure run directory exists
  await fs.mkdir(runDir, { recursive: true });

  console.log(`📁 Creating organized reports in: ${runDir}`);

  // Generate all three formats
  const jsonPath = join(runDir, 'report.json');
  const htmlPath = join(runDir, 'report.html');
  const pdfPath = join(runDir, 'report.pdf');

  try {
    // Generate JSON report
    console.log('📊 Generating JSON report...');
    await generateJsonReport(reportData, jsonPath);

    // Generate HTML report
    console.log('🌐 Generating HTML report...');
    await generateHtmlReport(reportData, htmlPath);

    // Generate PDF report using external Puppeteer (workaround for Chrome hanging issue)
    console.log('📄 Generating PDF report...');
    await generatePdfReportWorkaround(htmlPath, pdfPath);

    // Create run summary
    const readmePath = join(runDir, 'README.md');
    const readmeContent = createRunSummary(runId, reportData);
    await fs.writeFile(readmePath, readmeContent, 'utf-8');

    // Report success
    console.log(`✅ All reports generated successfully:`);
    console.log(`   • Location: ${runDir}`);
    console.log(`   • JSON Report: report.json`);
    console.log(`   • HTML Report: report.html`);
    console.log(`   • PDF Report: report.pdf`);
    console.log(`   • Run Summary: README.md`);
    console.log(`   • Total runs analyzed: ${reportData.summary_stats.total_runs}`);
    console.log(
      `   • Overall success rate: ${(reportData.summary_stats.overall_success_rate * 100).toFixed(1)}%`
    );
    console.log(
      `   • Average execution time: ${reportData.summary_stats.average_execution_time.toFixed(2)}s`
    );
    console.log(`   • Common trajectory patterns: ${reportData.common_trajectories.length}`);
  } catch (error) {
    throw new Error(
      `Failed to generate organized reports: ${error instanceof Error ? error.message : error}`
    );
  }
}

/**
 * Generate a single format report (legacy behavior for specific format requests)
 */
async function generateSingleFormatReport(
  reportData: ReportData,
  format: string,
  inputDir: string,
  customOutputPath?: string
): Promise<void> {
  // Determine output path and format
  const defaultFileName =
    format === 'html' ? 'report.html' : format === 'pdf' ? 'report.pdf' : 'report.json';
  const outputPath = customOutputPath || join(inputDir, defaultFileName);
  const resolvedOutputPath = resolve(outputPath);

  // Ensure output directory exists
  await fs.mkdir(resolve(resolvedOutputPath, '..'), { recursive: true });

  // Generate output based on format
  if (format === 'html') {
    await generateHtmlReport(reportData, resolvedOutputPath);
  } else if (format === 'json') {
    await generateJsonReport(reportData, resolvedOutputPath);
  } else if (format === 'pdf') {
    await generatePdfReport(reportData, resolvedOutputPath);
  } else {
    throw new Error(`Unsupported format: ${format}. Supported formats: json, html, pdf, all`);
  }

  console.log(`✅ Report generated successfully:`);
  console.log(`   • Output file: ${resolvedOutputPath}`);
  console.log(`   • Total runs analyzed: ${reportData.summary_stats.total_runs}`);
  console.log(
    `   • Overall success rate: ${(reportData.summary_stats.overall_success_rate * 100).toFixed(1)}%`
  );
  console.log(
    `   • Average execution time: ${reportData.summary_stats.average_execution_time.toFixed(2)}s`
  );
  console.log(`   • Common trajectory patterns: ${reportData.common_trajectories.length}`);
}

/**
 * Create a run summary markdown file
 */
function createRunSummary(runId: string, reportData: ReportData): string {
  return `# Run Summary: ${runId}

## Generated Reports
- **JSON Report**: report.json - Raw data and analysis results
- **HTML Report**: report.html - Interactive web report with charts  
- **PDF Report**: report.pdf - Print-ready formatted report

## Run Details
- **Timestamp**: ${new Date().toISOString()}
- **Total Runs Analyzed**: ${reportData.summary_stats.total_runs}
- **Overall Success Rate**: ${(reportData.summary_stats.overall_success_rate * 100).toFixed(1)}%
- **Average Execution Time**: ${reportData.summary_stats.average_execution_time.toFixed(2)}s
- **Common Trajectory Patterns**: ${reportData.common_trajectories.length}

## Analysis Summary
${
  reportData.summary_stats.total_runs > 0
    ? `
- **Total Test Cases**: ${reportData.summary_stats.total_runs}
- **Successful Runs**: ${Math.round(reportData.summary_stats.total_runs * reportData.summary_stats.overall_success_rate)}
- **Failed Runs**: ${reportData.summary_stats.total_runs - Math.round(reportData.summary_stats.total_runs * reportData.summary_stats.overall_success_rate)}
- **Average Duration**: ${reportData.summary_stats.average_execution_time.toFixed(2)} seconds
`
    : 'No run data available.'
}

## Usage
- Open \`report.html\` in a web browser for interactive viewing
- Use \`report.json\` for programmatic analysis  
- Print or share \`report.pdf\` for formal reports

## Matrix Parameters
${
  Object.keys(reportData.results_by_parameter).length > 0
    ? Object.keys(reportData.results_by_parameter)
        .map(
          (param) =>
            `- **${param}**: ${Object.keys(reportData.results_by_parameter[param]).length} variations`
        )
        .join('\n')
    : 'No parameter variations detected.'
}
`;
}

/**
 * Generate PDF using external Puppeteer (workaround for Chrome hanging in CLI context)
 */
async function generatePdfReportWorkaround(htmlPath: string, pdfPath: string): Promise<void> {
  const { spawn } = await import('child_process');

  return new Promise((resolve, reject) => {
    const nodeScript = `
const puppeteer = require('puppeteer');
const fs = require('fs');

(async () => {
  try {
    console.log('📄 Reading HTML from:', '${htmlPath}');
    const htmlContent = fs.readFileSync('${htmlPath}', 'utf-8');
    console.log('🚀 Launching Chrome for PDF conversion...');
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent(htmlContent);
    console.log('📋 Generating PDF...');
    await page.pdf({ path: '${pdfPath}', format: 'A4', printBackground: true });
    await browser.close();
    console.log('✅ PDF generated successfully');
  } catch (error) {
    console.error('❌ PDF generation failed:', error.message);
    process.exit(1);
  }
})();
`;

    const nodeProcess = spawn('node', ['-e', nodeScript], {
      stdio: 'inherit',
      cwd: process.cwd(),
    });

    nodeProcess.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`PDF generation process exited with code ${code}`));
      }
    });

    nodeProcess.on('error', (error) => {
      reject(new Error(`Failed to spawn PDF generation process: ${error.message}`));
    });
  });
}

/**
 * Validate that the input directory exists and is accessible
 */
async function validateInputDirectory(inputDir: string): Promise<void> {
  try {
    const stats = await fs.stat(inputDir);
    if (!stats.isDirectory()) {
      throw new Error(`Input path is not a directory: ${inputDir}`);
    }
  } catch (error) {
    if ((error as any).code === 'ENOENT') {
      throw new Error(`Input directory not found: ${inputDir}`);
    }
    throw new Error(`Cannot access input directory: ${inputDir}. ${(error as Error).message}`);
  }
}

/**
 * Find and process all run-*.json files in the input directory
 */
async function ingestRunData(inputDir: string): Promise<DataIngestionResult> {
  const fileStats = { processed: 0, skipped: 0, errors: [] as string[] };
  const validRuns: ScenarioRunResult[] = [];
  let matrixConfig: MatrixConfig | null = null;

  try {
    // Find all run-*.json files, prioritizing files in runs/ subdirectory
    const runFiles = await glob('**/run-*.json', { cwd: inputDir, absolute: true });

    if (runFiles.length === 0) {
      throw new Error('No run-*.json files found in the input directory');
    }

    console.log(`📁 Found ${runFiles.length} run files to process`);

    // Also look for matrix configuration file
    const configFiles = await glob('**/*.matrix.yaml', { cwd: inputDir, absolute: true });
    if (configFiles.length > 0) {
      try {
        // Read config file (content not used yet, but we validate it exists)
        await fs.readFile(configFiles[0], 'utf8');
        // For now, we'll create a basic config since we need yaml parsing
        // In a real implementation, we'd use a yaml parser here
        matrixConfig = {
          name: 'Matrix Configuration',
          description: 'Loaded from matrix run',
          base_scenario: 'scenario.yaml',
          runs_per_combination: 1,
          matrix: [],
        };
      } catch (error) {
        fileStats.errors.push(`Failed to load matrix config: ${(error as Error).message}`);
      }
    }

    // If no matrix config found, create a minimal default
    if (!matrixConfig) {
      matrixConfig = {
        name: 'Unknown Matrix',
        description: 'No matrix configuration file found',
        base_scenario: 'unknown.scenario.yaml',
        runs_per_combination: 1,
        matrix: [],
      };
    }

    // Process each run file
    for (const filePath of runFiles) {
      try {
        const fileContent = await fs.readFile(filePath, 'utf8');
        const runData = JSON.parse(fileContent);

        let transformedRun: ScenarioRunResult;

        // Check if this looks like a MatrixRunResult first (more common case)
        const isMatrixResult =
          runData.runId &&
          runData.combinationId &&
          typeof runData.startTime === 'string' &&
          typeof runData.endTime === 'string';

        if (isMatrixResult) {
          // This is a MatrixRunResult - transform it
          console.log(
            `🔧 [DEBUG] Detected MatrixRunResult format for ${filePath.split('/').pop()}`
          );
          const matrixResult = runData as MatrixRunResult;
          transformedRun = transformMatrixRunResultToScenarioRunResult(matrixResult);

          // Validate the transformed result
          const validationResult = ScenarioRunResultSchema.safeParse(transformedRun);
          if (!validationResult.success) {
            console.log(
              `🔧 [DEBUG] Transformation validation failed:`,
              validationResult.error.issues
            );
            throw new Error(
              `Transformed MatrixRunResult failed validation: ${JSON.stringify(validationResult.error.issues)}`
            );
          }

          transformedRun = validationResult.data as ScenarioRunResult;
          console.log(`🔧 [DEBUG] Successfully transformed MatrixRunResult to ScenarioRunResult`);
        } else {
          // Try to validate as ScenarioRunResult directly
          const scenarioValidation = ScenarioRunResultSchema.safeParse(runData);
          if (scenarioValidation.success) {
            transformedRun = scenarioValidation.data as ScenarioRunResult;
            console.log(
              `🔧 [DEBUG] Direct ScenarioRunResult validation successful for ${filePath.split('/').pop()}`
            );
          } else {
            console.log(
              `🔧 [DEBUG] File ${filePath.split('/').pop()} does not match any known format`
            );
            console.log(`🔧 [DEBUG] Available fields:`, Object.keys(runData));
            throw new Error(`File does not match ScenarioRunResult or MatrixRunResult format`);
          }
        }

        validRuns.push(transformedRun);
        fileStats.processed++;
      } catch (error) {
        fileStats.skipped++;
        const fileName = filePath.split('/').pop() || filePath;
        if (error instanceof SyntaxError) {
          fileStats.errors.push(`${fileName}: Invalid JSON format`);
        } else {
          fileStats.errors.push(`${fileName}: ${(error as Error).message}`);
        }
        console.warn(`⚠️  Skipping malformed file: ${fileName}`);
      }
    }

    // Extract matrix parameters from the run data if not available in config
    if (matrixConfig.matrix.length === 0 && validRuns.length > 0) {
      matrixConfig = inferMatrixConfigFromRuns(matrixConfig, validRuns);
    }
  } catch (error) {
    throw new Error(`Failed to process input directory: ${(error as Error).message}`);
  }

  return {
    validRuns,
    matrixConfig,
    fileStats,
  };
}

/**
 * Infer matrix configuration from the parameter variations found in run data
 */
function inferMatrixConfigFromRuns(
  baseConfig: MatrixConfig,
  runs: ScenarioRunResult[]
): MatrixConfig {
  const parameterVariations: Map<string, Set<any>> = new Map();

  // Collect all parameter variations
  runs.forEach((run) => {
    collectParameterPaths(run.parameters, '', parameterVariations);
  });

  // Convert to matrix axes
  const matrixAxes = Array.from(parameterVariations.entries())
    .filter(([_, values]) => values.size > 1) // Only include parameters that vary
    .map(([parameter, values]) => ({
      parameter,
      values: Array.from(values),
    }));

  return {
    ...baseConfig,
    matrix: matrixAxes,
  };
}

/**
 * Recursively collect all parameter paths and their values
 */
function collectParameterPaths(
  obj: any,
  currentPath: string,
  variations: Map<string, Set<any>>,
  maxDepth = 3,
  currentDepth = 0
): void {
  if (currentDepth >= maxDepth || obj === null || typeof obj !== 'object') {
    return;
  }

  Object.entries(obj).forEach(([key, value]) => {
    const paramPath = currentPath ? `${currentPath}.${key}` : key;

    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      // Recurse into nested objects
      collectParameterPaths(value, paramPath, variations, maxDepth, currentDepth + 1);
    } else {
      // Leaf value - track this parameter
      if (!variations.has(paramPath)) {
        variations.set(paramPath, new Set());
      }
      variations.get(paramPath)!.add(value);
    }
  });
}

/**
 * Generate JSON report file
 */
async function generateJsonReport(reportData: ReportData, outputPath: string): Promise<void> {
  await fs.writeFile(outputPath, JSON.stringify(reportData, null, 2), 'utf8');
}

/**
 * Generate HTML report file using the template
 */
async function generateHtmlReport(reportData: ReportData, outputPath: string): Promise<void> {
  // Load the HTML template - try built path first, then source path for development
  const builtTemplatePath = join(__dirname, 'src', 'assets', 'report_template.html');
  const sourceTemplatePath = join(
    __dirname,
    '..',
    '..',
    '..',
    'src',
    'commands',
    'report',
    'src',
    'assets',
    'report_template.html'
  );

  let templatePath: string;
  if (existsSync(builtTemplatePath)) {
    templatePath = builtTemplatePath;
  } else if (existsSync(sourceTemplatePath)) {
    templatePath = sourceTemplatePath;
  } else {
    throw new Error(
      `HTML template not found. Searched:\n- ${builtTemplatePath}\n- ${sourceTemplatePath}`
    );
  }

  try {
    const templateContent = await fs.readFile(templatePath, 'utf-8');

    // Inject the real data into the template
    const dataIslandStart = templateContent.indexOf(
      '<script id="report-data" type="application/json">'
    );
    if (dataIslandStart !== -1) {
      const dataIslandEnd = templateContent.indexOf('</script>', dataIslandStart);
      if (dataIslandEnd !== -1) {
        const dataIslandContent = templateContent.substring(dataIslandStart, dataIslandEnd + 8);

        // Replace the entire data island
        const htmlReport = templateContent.replace(
          dataIslandContent,
          `<script id="report-data" type="application/json">\n  ${JSON.stringify(reportData, null, 2)}\n</script>`
        );

        // Write the complete HTML report
        await fs.writeFile(outputPath, htmlReport, 'utf-8');
        return;
      }
    }

    // Fallback to regex approach if exact match fails
    const htmlReport = templateContent.replace(
      /<script id="report-data" type="application\/json">[\s\S]*?<\/script>/,
      `<script id="report-data" type="application/json">\n  ${JSON.stringify(reportData, null, 2)}\n</script>`
    );

    // Write the complete HTML report
    await fs.writeFile(outputPath, htmlReport, 'utf-8');
  } catch (error) {
    throw new Error(
      `Failed to generate HTML report: ${(error as Error).message}. Make sure the HTML template exists at ${templatePath}`
    );
  }
}

/**
 * Generate PDF report file by first creating HTML then converting to PDF
 */
async function generatePdfReport(reportData: ReportData, outputPath: string): Promise<void> {
  console.log('📋 Generating PDF report...');

  try {
    // First generate the HTML content (same as HTML report)
    // Try built path first, then source path for development
    const builtTemplatePath = join(__dirname, 'src', 'assets', 'report_template.html');
    const sourceTemplatePath = join(
      __dirname,
      '..',
      '..',
      '..',
      'src',
      'commands',
      'report',
      'src',
      'assets',
      'report_template.html'
    );

    let templatePath: string;
    if (existsSync(builtTemplatePath)) {
      templatePath = builtTemplatePath;
    } else if (existsSync(sourceTemplatePath)) {
      templatePath = sourceTemplatePath;
    } else {
      throw new Error(
        `HTML template not found. Searched:\n- ${builtTemplatePath}\n- ${sourceTemplatePath}`
      );
    }
    const templateContent = await fs.readFile(templatePath, 'utf-8');

    // Inject the real data into the template
    const htmlContent = templateContent.replace(
      /<script id="report-data" type="application\/json">\s*\{\s*<\/script>/s,
      `<script id="report-data" type="application/json">\n  ${JSON.stringify(reportData, null, 2)}\n</script>`
    );

    console.log('🔄 Converting HTML to PDF using Puppeteer...');

    // Use our PDF generator to convert HTML to PDF
    await generatePerformanceReportPdf(htmlContent, outputPath);

    console.log('✅ PDF report generated successfully');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    // Provide helpful error messages for common issues
    if (errorMessage.includes('Could not find Chromium')) {
      throw new Error(
        'PDF generation failed: Chromium browser not found. Please install Puppeteer dependencies or use --format html instead.'
      );
    } else if (errorMessage.includes('Navigation timeout')) {
      throw new Error(
        'PDF generation failed: Timeout while loading report. The report may be too large or complex.'
      );
    } else {
      throw new Error(`Failed to generate PDF report: ${errorMessage}`);
    }
  }
}

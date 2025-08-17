/**
 * Report Generate Command Implementation
 *
 * This module implements the 'elizaos report generate' subcommand that processes
 * raw JSON outputs from Scenario Matrix runs and generates comprehensive reports.
 *
 * Required by ticket #5787 - CLI Command Registration and Implementation.
 */

import { Command } from 'commander';
import { promises as fs } from 'fs';
import { join, resolve } from 'path';
import { glob } from 'glob';
import { AnalysisEngine } from './src/analysis-engine';
import { ScenarioRunResult, ScenarioRunResultSchema } from '../scenario/src/schema';
import { MatrixConfig } from '../scenario/src/matrix-schema';
import { ReportData, ReportDataSchema } from './src/report-schema';

export interface GenerateCommandOptions {
  outputPath?: string;
  format?: string;
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
      'Path where the report file will be saved (defaults to <input_dir>/report.json or report.html)'
    )
    .option(
      '--format <format>',
      'Output format: json or html (default: json)',
      'json'
    )
    .action(async (inputDir: string, options: GenerateCommandOptions) => {
      try {
        await executeGenerateCommand(inputDir, options);
      } catch (error) {
        console.error('❌ Report generation failed:', error instanceof Error ? error.message : error);
        process.exit(1);
      }
    });

  return command;
}

/**
 * Main execution logic for the generate command
 */
export async function executeGenerateCommand(inputDir: string, options: GenerateCommandOptions): Promise<void> {
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
    fileStats.errors.forEach(error => console.log(`     - ${error}`));
  }

  if (validRuns.length === 0) {
    throw new Error('No valid run files found in the input directory');
  }

  // Generate report using the AnalysisEngine
  console.log(`⚙️  Analyzing ${validRuns.length} runs...`);
  const analysisEngine = new AnalysisEngine();
  const reportData = analysisEngine.processRunResults(
    validRuns,
    matrixConfig,
    resolvedInputDir,
    { processed: fileStats.processed, skipped: fileStats.skipped }
  );

  // Validate the generated report data
  try {
    ReportDataSchema.parse(reportData);
  } catch (validationError) {
    console.warn('⚠️  Generated report data failed schema validation:', validationError);
  }

  // Determine output path and format
  const format = options.format || 'json';
  const defaultFileName = format === 'html' ? 'report.html' : 'report.json';
  const outputPath = options.outputPath || join(resolvedInputDir, defaultFileName);
  const resolvedOutputPath = resolve(outputPath);

  // Ensure output directory exists
  await fs.mkdir(resolve(resolvedOutputPath, '..'), { recursive: true });

  // Generate output based on format
  if (format === 'html') {
    await generateHtmlReport(reportData, resolvedOutputPath);
  } else if (format === 'json') {
    await generateJsonReport(reportData, resolvedOutputPath);
  } else {
    throw new Error(`Unsupported format: ${format}. Supported formats: json, html`);
  }

  console.log(`✅ Report generated successfully:`);
  console.log(`   • Output file: ${resolvedOutputPath}`);
  console.log(`   • Total runs analyzed: ${reportData.summary_stats.total_runs}`);
  console.log(`   • Overall success rate: ${(reportData.summary_stats.overall_success_rate * 100).toFixed(1)}%`);
  console.log(`   • Average execution time: ${reportData.summary_stats.average_execution_time.toFixed(2)}s`);
  console.log(`   • Common trajectory patterns: ${reportData.common_trajectories.length}`);
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
    // Find all run-*.json files
    const runFiles = await glob('**/run-*.json', { cwd: inputDir, absolute: true });

    if (runFiles.length === 0) {
      throw new Error('No run-*.json files found in the input directory');
    }

    console.log(`📁 Found ${runFiles.length} run files to process`);

    // Also look for matrix configuration file
    const configFiles = await glob('**/*.matrix.yaml', { cwd: inputDir, absolute: true });
    if (configFiles.length > 0) {
      try {
        const configContent = await fs.readFile(configFiles[0], 'utf8');
        // For now, we'll create a basic config since we need yaml parsing
        // In a real implementation, we'd use a yaml parser here
        matrixConfig = {
          name: 'Matrix Configuration',
          description: 'Loaded from matrix run',
          base_scenario: 'scenario.yaml',
          runs_per_combination: 1,
          matrix: []
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
        matrix: []
      };
    }

    // Process each run file
    for (const filePath of runFiles) {
      try {
        const fileContent = await fs.readFile(filePath, 'utf8');
        const runData = JSON.parse(fileContent);

        // Validate against schema
        const validatedRun = ScenarioRunResultSchema.parse(runData);
        validRuns.push(validatedRun);
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
    fileStats
  };
}

/**
 * Infer matrix configuration from the parameter variations found in run data
 */
function inferMatrixConfigFromRuns(baseConfig: MatrixConfig, runs: ScenarioRunResult[]): MatrixConfig {
  const parameterVariations: Map<string, Set<any>> = new Map();

  // Collect all parameter variations
  runs.forEach(run => {
    collectParameterPaths(run.parameters, '', parameterVariations);
  });

  // Convert to matrix axes
  const matrixAxes = Array.from(parameterVariations.entries())
    .filter(([_, values]) => values.size > 1) // Only include parameters that vary
    .map(([parameter, values]) => ({
      parameter,
      values: Array.from(values)
    }));

  return {
    ...baseConfig,
    matrix: matrixAxes
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
  await fs.writeFile(
    outputPath,
    JSON.stringify(reportData, null, 2),
    'utf8'
  );
}

/**
 * Generate HTML report file using the template
 */
async function generateHtmlReport(reportData: ReportData, outputPath: string): Promise<void> {
  // Load the HTML template
  const templatePath = join(__dirname, 'src', 'assets', 'report_template.html');

  try {
    const templateContent = await fs.readFile(templatePath, 'utf-8');

    // Inject the real data into the template
    const htmlReport = templateContent.replace(
      '<script id="report-data" type="application/json">\n        {}\n    </script>',
      `<script id="report-data" type="application/json">\n        ${JSON.stringify(reportData, null, 2)}\n    </script>`
    );

    // Write the complete HTML report
    await fs.writeFile(outputPath, htmlReport, 'utf-8');

  } catch (error) {
    throw new Error(`Failed to generate HTML report: ${(error as Error).message}. Make sure the HTML template exists at ${templatePath}`);
  }
}

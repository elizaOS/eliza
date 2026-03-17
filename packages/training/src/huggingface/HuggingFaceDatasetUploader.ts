/**
 * HuggingFace Dataset Uploader
 *
 * Prepares and uploads benchmark datasets to HuggingFace Hub for public access.
 * Creates dataset cards with visualizations, metrics, and usage examples.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { SimulationMetrics } from "../benchmark/SimulationEngine";
import { calculateArrayStats, logger } from "../utils";
import {
  getHuggingFaceToken,
  HuggingFaceUploadUtil,
  requireHuggingFaceToken,
} from "./shared/HuggingFaceUploadUtil";

export interface BenchmarkRecord {
  benchmarkId: string;
  modelId: string;
  modelVersion: string;
  modelName: string;
  runAt: string;
  metrics: SimulationMetrics;
  benchmarkSnapshot: {
    duration: number;
    tickInterval: number;
    markets: number;
    ticks: number;
  };
}

export interface DatasetMetadata {
  datasetName: string;
  version: string;
  description: string;
  createdAt: string;
  totalBenchmarks: number;
  models: string[];
  benchmarkTypes: string[];
  license: string;
}

export interface UploadOptions {
  /** Dataset name (e.g., 'elizaos/agent-benchmarks') */
  datasetName: string;
  version?: string;
  description?: string;
  private?: boolean;
  benchmarkDir?: string;
  outputDir?: string;
}

export interface UploadResult {
  success: boolean;
  datasetUrl?: string;
  version: string;
  filesUploaded: number;
  error?: string;
}

export class HuggingFaceDatasetUploader {
  private huggingFaceToken: string | undefined;

  constructor(huggingFaceToken?: string) {
    this.huggingFaceToken = huggingFaceToken || getHuggingFaceToken();
  }

  /**
   * Prepare and upload benchmark dataset to HuggingFace
   */
  async uploadDataset(options: UploadOptions): Promise<UploadResult> {
    try {
      logger.info("Starting HuggingFace dataset upload", {
        datasetName: options.datasetName,
      });

      // Validate token (throws if not set)
      const token = this.huggingFaceToken || requireHuggingFaceToken();
      this.huggingFaceToken = token;

      // Set defaults
      const version = options.version || this.generateVersion();
      const benchmarkDir =
        options.benchmarkDir || path.join(process.cwd(), "benchmarks");
      const outputDir =
        options.outputDir ||
        path.join(process.cwd(), "exports", "huggingface", version);

      // Step 1: Collect benchmark data
      logger.info("Collecting benchmark data", { benchmarkDir });
      const benchmarks = await this.collectBenchmarkData(benchmarkDir);
      logger.info(`Collected ${benchmarks.length} benchmark records`);

      if (benchmarks.length === 0) {
        throw new Error("No benchmark data found to upload");
      }

      // Step 2: Prepare dataset files
      logger.info("Preparing dataset files", { outputDir });
      await fs.mkdir(outputDir, { recursive: true });

      const metadata = await this.prepareDatasetFiles(benchmarks, outputDir, {
        datasetName: options.datasetName,
        version,
        description:
          options.description || "Autonomous agent benchmark results",
      });

      // Step 3: Generate dataset card
      logger.info("Generating dataset card");
      await this.generateDatasetCard(metadata, benchmarks, outputDir);

      // Step 4: Create repository if it doesn't exist
      logger.info("Ensuring repository exists", {
        datasetName: options.datasetName,
      });
      await this.ensureRepository(
        options.datasetName,
        options.private ?? false,
      );

      // Step 5: Upload to HuggingFace
      logger.info("Uploading to HuggingFace", {
        datasetName: options.datasetName,
      });
      const filesUploaded = await this.uploadToHub(
        options.datasetName,
        outputDir,
        options.private ?? false,
      );

      const datasetUrl = `https://huggingface.co/datasets/${options.datasetName}`;

      logger.info("Dataset uploaded successfully", {
        datasetUrl,
        filesUploaded,
      });

      return {
        success: true,
        datasetUrl,
        version,
        filesUploaded,
      };
    } catch (error) {
      logger.error("Failed to upload dataset", { error });
      return {
        success: false,
        version: options.version || "unknown",
        filesUploaded: 0,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Collect benchmark data from files
   */
  private async collectBenchmarkData(
    benchmarkDir: string,
  ): Promise<BenchmarkRecord[]> {
    const records: BenchmarkRecord[] = [];

    // Collect from model-comparison directory
    const comparisonDir = path.join(benchmarkDir, "model-comparison");
    if (await this.fileExists(comparisonDir)) {
      const comparisonFile = path.join(comparisonDir, "comparison.json");
      if (await this.fileExists(comparisonFile)) {
        const data = JSON.parse(await fs.readFile(comparisonFile, "utf-8"));
        for (const result of data.results || []) {
          if (result.metrics) {
            records.push({
              benchmarkId: data.benchmark || "comparison",
              modelId: result.model.modelId,
              modelVersion: "baseline",
              modelName: result.model.displayName,
              runAt: data.runAt,
              metrics: result.metrics,
              benchmarkSnapshot: {
                duration: result.metrics.timing?.totalDuration || 0,
                tickInterval: 60,
                markets: 10,
                ticks: Math.floor(
                  (result.metrics.timing?.totalDuration || 0) / 60,
                ),
              },
            });
          }
        }
      }
    }

    // Collect from baselines directory
    const baselinesDir = path.join(benchmarkDir, "baselines");
    if (await this.fileExists(baselinesDir)) {
      const files = await fs.readdir(baselinesDir);
      for (const file of files) {
        if (file.endsWith(".json") && file.startsWith("baseline-")) {
          const filePath = path.join(baselinesDir, file);
          const data = JSON.parse(await fs.readFile(filePath, "utf-8"));

          // Skip if no metrics
          if (!data.metrics) continue;

          records.push({
            benchmarkId:
              data.benchmark?.id ||
              data.benchmark?.path ||
              file.replace(".json", ""),
            modelId: data.model?.modelId || "unknown",
            modelVersion: data.model?.version || "baseline",
            modelName:
              data.model?.displayName ||
              data.model?.name ||
              file.replace(".json", ""),
            runAt: data.runAt || new Date().toISOString(),
            metrics: data.metrics,
            benchmarkSnapshot: {
              duration:
                data.timing?.totalDuration ||
                data.metrics.timing?.totalDuration ||
                0,
              tickInterval: 60,
              markets: 10,
              ticks: Math.floor(
                (data.timing?.totalDuration ||
                  data.metrics.timing?.totalDuration ||
                  0) / 60,
              ),
            },
          });
        }
      }
    }

    // Collect from test-baselines directory
    const testBaselinesDir = path.join(benchmarkDir, "test-baselines");
    if (await this.fileExists(testBaselinesDir)) {
      const subdirs = await fs.readdir(testBaselinesDir);
      for (const subdir of subdirs) {
        const metricsFile = path.join(testBaselinesDir, subdir, "metrics.json");
        if (await this.fileExists(metricsFile)) {
          const data = JSON.parse(await fs.readFile(metricsFile, "utf-8"));

          // Skip if no required fields
          if (!data.totalPnl && !data.predictionMetrics) continue;

          records.push({
            benchmarkId: data.benchmarkId || "test-benchmark",
            modelId: subdir,
            modelVersion: "test-baseline",
            modelName: subdir,
            runAt: data.runAt || new Date().toISOString(),
            metrics: data,
            benchmarkSnapshot: {
              duration: data.timing?.totalDuration || 0,
              tickInterval: 60,
              markets: 10,
              ticks: Math.floor((data.timing?.totalDuration || 0) / 60),
            },
          });
        }
      }
    }

    return records;
  }

  /**
   * Prepare dataset files in HuggingFace format
   */
  private async prepareDatasetFiles(
    benchmarks: BenchmarkRecord[],
    outputDir: string,
    options: { datasetName: string; version: string; description: string },
  ): Promise<DatasetMetadata> {
    // Create data.jsonl with all benchmark records
    const jsonlPath = path.join(outputDir, "data.jsonl");
    const jsonlLines = benchmarks.map((b) => JSON.stringify(b)).join("\n");
    await fs.writeFile(jsonlPath, jsonlLines);

    // Create metadata.json
    const metadata: DatasetMetadata = {
      datasetName: options.datasetName,
      version: options.version,
      description: options.description,
      createdAt: new Date().toISOString(),
      totalBenchmarks: benchmarks.length,
      models: Array.from(new Set(benchmarks.map((b) => b.modelName))),
      benchmarkTypes: Array.from(new Set(benchmarks.map((b) => b.benchmarkId))),
      license: "MIT",
    };

    const metadataPath = path.join(outputDir, "metadata.json");
    await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));

    // Create summary statistics
    const summary = this.calculateSummaryStatistics(benchmarks);
    const summaryPath = path.join(outputDir, "summary.json");
    await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2));

    return metadata;
  }

  /**
   * Generate README.md dataset card for HuggingFace
   */
  private async generateDatasetCard(
    metadata: DatasetMetadata,
    benchmarks: BenchmarkRecord[],
    outputDir: string,
  ): Promise<void> {
    const summary = this.calculateSummaryStatistics(benchmarks);
    const brandName = process.env.TRAINING_BRAND_NAME || "ElizaOS";
    const brandOrg = process.env.TRAINING_BRAND_ORG || "ElizaOS Contributors";
    const platformName =
      process.env.TRAINING_PLATFORM_NAME || "ElizaOS-compatible runtimes";
    const brandTag = brandName.toLowerCase().replace(/\s+/g, "-");

    const card = `---
license: ${metadata.license}
task_categories:
- reinforcement-learning
- agent-evaluation
tags:
- ${brandTag}
- prediction-markets
- trading-agents
- benchmarks
size_categories:
- n<1K
---

# ${metadata.datasetName}

## Dataset Description

${metadata.description}

This dataset contains benchmark results for autonomous trading agents on prediction-market style environments. Each record includes comprehensive performance metrics, market conditions, and agent behavior data.

**Version:** ${metadata.version}  
**Created:** ${metadata.createdAt}  
**Total Benchmarks:** ${metadata.totalBenchmarks}  
**Models Evaluated:** ${metadata.models.length}

## Dataset Statistics

### Overall Performance

| Metric | Mean | Median | Std Dev | Min | Max |
|--------|------|--------|---------|-----|-----|
| Total P&L | ${summary.pnl.mean.toFixed(2)} | ${summary.pnl.median.toFixed(2)} | ${summary.pnl.std.toFixed(2)} | ${summary.pnl.min.toFixed(2)} | ${summary.pnl.max.toFixed(2)} |
| Prediction Accuracy | ${(summary.accuracy.mean * 100).toFixed(1)}% | ${(summary.accuracy.median * 100).toFixed(1)}% | ${(summary.accuracy.std * 100).toFixed(1)}% | ${(summary.accuracy.min * 100).toFixed(1)}% | ${(summary.accuracy.max * 100).toFixed(1)}% |
| Optimality Score | ${summary.optimality.mean.toFixed(1)} | ${summary.optimality.median.toFixed(1)} | ${summary.optimality.std.toFixed(1)} | ${summary.optimality.min.toFixed(1)} | ${summary.optimality.max.toFixed(1)} |

### Model Leaderboard

${this.generateLeaderboardTable(benchmarks)}

## Dataset Structure

### Data Fields

- \`benchmarkId\`: Unique identifier for the benchmark scenario
- \`modelId\`: Model identifier
- \`modelVersion\`: Model version (baseline, trained, etc.)
- \`modelName\`: Human-readable model name
- \`runAt\`: ISO timestamp of benchmark execution
- \`metrics\`: Performance metrics object
  - \`totalPnl\`: Total profit/loss across all positions
  - \`predictionMetrics\`: Prediction market performance
    - \`totalPositions\`: Number of prediction positions taken
    - \`correctPredictions\`: Number of correct predictions
    - \`accuracy\`: Prediction accuracy (0-1)
  - \`perpMetrics\`: Perpetual trading performance
    - \`totalTrades\`: Number of perpetual trades
    - \`winRate\`: Win rate for perpetual trades
  - \`socialMetrics\`: Social engagement metrics
  - \`timing\`: Execution timing statistics
  - \`optimalityScore\`: How close to optimal play (0-100)

### Data Splits

This dataset does not have predefined splits. Use for model evaluation and comparison.

## Usage

### Load Dataset

\`\`\`python
from datasets import load_dataset

dataset = load_dataset("${metadata.datasetName}")
\`\`\`

### Example Analysis

\`\`\`python
import pandas as pd

# Load as DataFrame
df = pd.read_json("hf://datasets/${metadata.datasetName}/data.jsonl", lines=True)

# Compare models
model_performance = df.groupby('modelName').agg({
    'metrics.totalPnl': 'mean',
    'metrics.predictionMetrics.accuracy': 'mean',
    'metrics.optimalityScore': 'mean'
})

print(model_performance.sort_values('metrics.totalPnl', ascending=False))
\`\`\`

## Benchmark Details

### Environment

- **Platform:** ${platformName}
- **Market Types:** Prediction markets + perpetual futures
- **Tick Interval:** ${benchmarks[0]?.benchmarkSnapshot.tickInterval || 60} seconds
- **Duration:** ${Math.floor((benchmarks[0]?.benchmarkSnapshot.duration || 0) / 60000)} minutes

### Evaluation Metrics

1. **Total P&L:** Cumulative profit/loss across all positions
2. **Prediction Accuracy:** Percentage of correct market outcome predictions
3. **Perp Win Rate:** Percentage of profitable perpetual trades
4. **Optimality Score:** Alignment with theoretically optimal actions (0-100)
5. **Response Time:** Agent decision-making speed

## Citation

If you use this dataset in your research, please cite:

\`\`\`bibtex
@dataset{${brandTag}_benchmarks_${metadata.version.replace(/\./g, "_")},
  title = {${brandName} Agent Benchmarks},
  author = {${brandOrg}},
  year = {${new Date().getFullYear()}},
  version = {${metadata.version}},
  url = {https://huggingface.co/datasets/${metadata.datasetName}}
}
\`\`\`

## License

${metadata.license}

## Contact

For questions or issues, please open an issue on the repository.
`;

    const cardPath = path.join(outputDir, "README.md");
    await fs.writeFile(cardPath, card);
  }

  /**
   * Generate leaderboard table for dataset card
   */
  private generateLeaderboardTable(benchmarks: BenchmarkRecord[]): string {
    // Group by model and calculate averages
    const modelStats = new Map<
      string,
      { pnl: number[]; accuracy: number[]; optimality: number[] }
    >();

    for (const benchmark of benchmarks) {
      if (!modelStats.has(benchmark.modelName)) {
        modelStats.set(benchmark.modelName, {
          pnl: [],
          accuracy: [],
          optimality: [],
        });
      }
      const stats = modelStats.get(benchmark.modelName);
      if (!stats) continue;
      stats.pnl.push(benchmark.metrics.totalPnl);
      stats.accuracy.push(benchmark.metrics.predictionMetrics.accuracy);
      stats.optimality.push(benchmark.metrics.optimalityScore);
    }

    // Calculate averages and sort by P&L
    const leaderboard = Array.from(modelStats.entries())
      .map(([model, stats]) => ({
        model,
        avgPnl: stats.pnl.reduce((a, b) => a + b, 0) / stats.pnl.length,
        avgAccuracy:
          stats.accuracy.reduce((a, b) => a + b, 0) / stats.accuracy.length,
        avgOptimality:
          stats.optimality.reduce((a, b) => a + b, 0) / stats.optimality.length,
        runs: stats.pnl.length,
      }))
      .sort((a, b) => b.avgPnl - a.avgPnl);

    let table = "| Rank | Model | Avg P&L | Accuracy | Optimality | Runs |\n";
    table += "|------|-------|---------|----------|------------|------|\n";

    leaderboard.forEach((entry, index) => {
      table += `| ${index + 1} | ${entry.model} | ${entry.avgPnl.toFixed(2)} | ${(entry.avgAccuracy * 100).toFixed(1)}% | ${entry.avgOptimality.toFixed(1)} | ${entry.runs} |\n`;
    });

    return table;
  }

  /**
   * Calculate summary statistics
   */
  private calculateSummaryStatistics(benchmarks: BenchmarkRecord[]): {
    pnl: {
      mean: number;
      median: number;
      std: number;
      min: number;
      max: number;
    };
    accuracy: {
      mean: number;
      median: number;
      std: number;
      min: number;
      max: number;
    };
    optimality: {
      mean: number;
      median: number;
      std: number;
      min: number;
      max: number;
    };
  } {
    const pnls = benchmarks
      .map((b) => b.metrics.totalPnl)
      .sort((a, b) => a - b);
    const accuracies = benchmarks
      .map((b) => b.metrics.predictionMetrics.accuracy)
      .sort((a, b) => a - b);
    const optimalities = benchmarks
      .map((b) => b.metrics.optimalityScore)
      .sort((a, b) => a - b);

    return {
      pnl: calculateArrayStats(pnls),
      accuracy: calculateArrayStats(accuracies),
      optimality: calculateArrayStats(optimalities),
    };
  }

  /**
   * Ensure repository exists on HuggingFace
   * Uses shared utility for consistent behavior
   */
  private async ensureRepository(
    datasetName: string,
    isPrivate: boolean,
  ): Promise<void> {
    if (!this.huggingFaceToken) {
      throw new Error("HuggingFace token not configured");
    }

    await HuggingFaceUploadUtil.ensureRepository(
      datasetName,
      "dataset",
      this.huggingFaceToken,
      isPrivate,
    );
  }

  /**
   * Upload files to HuggingFace Hub
   * Uses shared utility for consistent upload behavior
   */
  private async uploadToHub(
    datasetName: string,
    localDir: string,
    _isPrivate: boolean,
  ): Promise<number> {
    if (!this.huggingFaceToken) {
      throw new Error("HuggingFace token not configured");
    }

    try {
      // Use shared upload utility
      const { HuggingFaceUploadUtil } = await import(
        "./shared/HuggingFaceUploadUtil"
      );

      return await HuggingFaceUploadUtil.uploadDirectory(
        datasetName,
        "dataset",
        localDir,
        this.huggingFaceToken,
      );
    } catch (error) {
      logger.error("Failed to upload to HuggingFace Hub", { error });

      // Provide helpful manual upload instructions
      const { HuggingFaceUploadUtil } = await import(
        "./shared/HuggingFaceUploadUtil"
      );
      const instructions = HuggingFaceUploadUtil.getManualUploadInstructions(
        datasetName,
        "dataset",
        localDir,
      );

      logger.info("To upload manually:", { instructions });

      throw error;
    }
  }

  /**
   * Generate version string (YYYY.MM.DD format)
   */
  private generateVersion(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    return `${year}.${month}.${day}`;
  }

  /**
   * Check if file exists
   */
  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}

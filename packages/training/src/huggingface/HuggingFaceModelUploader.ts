/**
 * HuggingFace Model Uploader
 *
 * Uploads trained RL models to HuggingFace Hub with benchmark results and model cards.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { getTrainingDataAdapter } from "../adapter";
import {
  type JsonValue,
  parseSimulationMetrics,
} from "../benchmark/parseSimulationMetrics";
import type { SimulationMetrics } from "../benchmark/SimulationEngine";
import { logger } from "../utils";
import {
  getHuggingFaceToken,
  HuggingFaceUploadUtil,
  requireHuggingFaceToken,
} from "./shared/HuggingFaceUploadUtil";

/**
 * Simplified benchmark result for HuggingFace model cards
 * Uses string date for JSON serialization compatibility
 */
export interface ModelCardBenchmarkResult {
  benchmarkId: string;
  runAt: string;
  metrics: SimulationMetrics;
}

export interface ModelUploadOptions {
  /** Database model ID */
  modelId: string;
  /** HuggingFace model name (e.g., 'elizaos/agent-v1') */
  modelName: string;
  description?: string;
  private?: boolean;
  includeWeights?: boolean;
  outputDir?: string;
}

export interface ModelUploadResult {
  success: boolean;
  modelUrl?: string;
  modelId: string;
  filesUploaded: number;
  error?: string;
}

export interface ModelCardData {
  modelId: string;
  modelName: string;
  version: string;
  baseModel: string;
  trainedAt: Date;
  trainingRunId?: string;
  benchmarkResults: ModelCardBenchmarkResult[];
  metrics: {
    avgPnl: number;
    avgAccuracy: number;
    avgOptimality: number;
    benchmarkCount: number;
  };
}

export class HuggingFaceModelUploader {
  private huggingFaceToken: string | undefined;

  constructor(huggingFaceToken?: string) {
    this.huggingFaceToken = huggingFaceToken || getHuggingFaceToken();
  }

  /**
   * Upload model to HuggingFace with benchmarks and model card
   */
  async uploadModel(options: ModelUploadOptions): Promise<ModelUploadResult> {
    try {
      logger.info("Starting HuggingFace model upload", {
        modelId: options.modelId,
      });

      // Validate token (throws if not set)
      const token = this.huggingFaceToken || requireHuggingFaceToken();
      this.huggingFaceToken = token;

      // Step 1: Load model from database
      const adapter = getTrainingDataAdapter();
      const model = await adapter.getModelById(options.modelId);

      if (!model) {
        throw new Error(`Model not found: ${options.modelId}`);
      }

      // Step 2: Get benchmark results
      logger.info("Loading benchmark results", { modelId: options.modelId });
      const modelBenchmarks = await this.getBenchmarkResults(options.modelId);

      if (modelBenchmarks.length === 0) {
        logger.warn("No benchmark results found for model", {
          modelId: options.modelId,
        });
      }

      // Step 3: Prepare model card data
      const cardData: ModelCardData = {
        modelId: model.modelId,
        modelName: options.modelName,
        version: model.version,
        baseModel: model.baseModel,
        trainedAt: model.createdAt,
        trainingRunId: model.trainingBatch || undefined,
        benchmarkResults: modelBenchmarks,
        metrics: this.calculateAverageMetrics(modelBenchmarks),
      };

      // Step 4: Create output directory
      const outputDir =
        options.outputDir ||
        path.join(process.cwd(), "exports", "models", model.version);
      await fs.mkdir(outputDir, { recursive: true });

      // Step 5: Generate model card
      logger.info("Generating model card");
      await this.generateModelCard(cardData, outputDir);

      // Step 6: Save metadata
      const metadataPath = path.join(outputDir, "model_metadata.json");
      await fs.writeFile(
        metadataPath,
        JSON.stringify(
          {
            modelId: model.modelId,
            version: model.version,
            baseModel: model.baseModel,
            storagePath: model.storagePath,
            trainingBatch: model.trainingBatch,
            trainedAt: model.createdAt.toISOString(),
            benchmarkScore: model.benchmarkScore,
            avgReward: model.avgReward,
            accuracy: model.accuracy,
          },
          null,
          2,
        ),
      );

      // Step 7: Save benchmark results
      const benchmarksPath = path.join(outputDir, "benchmark_results.json");
      await fs.writeFile(
        benchmarksPath,
        JSON.stringify(modelBenchmarks, null, 2),
      );

      // Step 8: Upload to HuggingFace (if weights available and requested)
      let filesUploaded = 2; // README.md + metadata

      if (options.includeWeights && model.storagePath) {
        logger.info("Uploading model to HuggingFace", {
          modelName: options.modelName,
        });
        const uploadCount = await this.uploadToHub(
          options.modelName,
          outputDir,
          options.private ?? false,
        );
        filesUploaded = uploadCount;
      } else {
        logger.info(
          "Skipping model weight upload (not requested or no weights available)",
        );
      }

      const modelUrl = `https://huggingface.co/${options.modelName}`;

      logger.info("Model uploaded successfully", { modelUrl, filesUploaded });

      // Update model status in database
      await adapter.updateModelStatus(options.modelId, "deployed", {
        deployedAt: new Date(),
      });

      return {
        success: true,
        modelUrl,
        modelId: options.modelId,
        filesUploaded,
      };
    } catch (error) {
      logger.error("Failed to upload model", { error });
      return {
        success: false,
        modelId: options.modelId,
        filesUploaded: 0,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Get benchmark results for a model
   */
  private async getBenchmarkResults(
    modelId: string,
  ): Promise<ModelCardBenchmarkResult[]> {
    // Query benchmark results from database
    try {
      const results =
        await getTrainingDataAdapter().getBenchmarkResultsByModel(modelId);

      return results.map((r) => ({
        benchmarkId: r.benchmarkId,
        runAt: r.runAt.toISOString(),
        // detailedMetrics is stored as JSON in database, validate it matches SimulationMetrics
        metrics: parseSimulationMetrics(r.detailedMetrics as JsonValue),
      }));
    } catch (error) {
      logger.warn("Could not load benchmark results from database", { error });

      // Fallback to files if database fails
      return await this.getBenchmarkResultsFromFiles(modelId);
    }
  }

  /**
   * Fallback: Get benchmark results from files
   */
  private async getBenchmarkResultsFromFiles(
    modelId: string,
  ): Promise<ModelCardBenchmarkResult[]> {
    const results: ModelCardBenchmarkResult[] = [];

    try {
      const benchmarksDir = path.join(process.cwd(), "benchmarks");
      const files = await fs.readdir(benchmarksDir);

      for (const file of files) {
        if (file.endsWith(".json") && file.includes(modelId)) {
          const filePath = path.join(benchmarksDir, file);
          const data = JSON.parse(await fs.readFile(filePath, "utf-8"));

          if (data.metrics) {
            results.push({
              benchmarkId: data.benchmarkId || file,
              runAt: data.runAt || new Date().toISOString(),
              metrics: data.metrics,
            });
          }
        }
      }
    } catch (error) {
      logger.warn("Could not load benchmark results from files either", {
        error,
      });
    }

    return results;
  }

  /**
   * Calculate average metrics across benchmarks
   */
  private calculateAverageMetrics(
    benchmarkResults: ModelCardBenchmarkResult[],
  ): {
    avgPnl: number;
    avgAccuracy: number;
    avgOptimality: number;
    benchmarkCount: number;
  } {
    if (benchmarkResults.length === 0) {
      return {
        avgPnl: 0,
        avgAccuracy: 0,
        avgOptimality: 0,
        benchmarkCount: 0,
      };
    }

    const totalPnl = benchmarkResults.reduce(
      (sum, r) => sum + r.metrics.totalPnl,
      0,
    );
    const totalAccuracy = benchmarkResults.reduce(
      (sum, r) => sum + r.metrics.predictionMetrics.accuracy,
      0,
    );
    const totalOptimality = benchmarkResults.reduce(
      (sum, r) => sum + r.metrics.optimalityScore,
      0,
    );

    return {
      avgPnl: totalPnl / benchmarkResults.length,
      avgAccuracy: totalAccuracy / benchmarkResults.length,
      avgOptimality: totalOptimality / benchmarkResults.length,
      benchmarkCount: benchmarkResults.length,
    };
  }

  /**
   * Generate model card for HuggingFace
   */
  private async generateModelCard(
    data: ModelCardData,
    outputDir: string,
  ): Promise<void> {
    const brandName = process.env.TRAINING_BRAND_NAME || "ElizaOS";
    const brandOrg = process.env.TRAINING_BRAND_ORG || "ElizaOS Contributors";
    const platformName =
      process.env.TRAINING_PLATFORM_NAME || "ElizaOS-compatible runtimes";
    const brandTag = brandName.toLowerCase().replace(/\s+/g, "-");
    const citationKey = `${brandTag}_agent_${data.version.replace(/\./g, "_")}`;

    const card = `---
license: mit
library_name: transformers
tags:
- ${brandTag}
- reinforcement-learning
- trading-agent
- prediction-markets
base_model: ${data.baseModel}
---

# ${data.modelName}

Autonomous agent trained with reinforcement learning for market-style decision making.

## Model Details

- **Version:** ${data.version}
- **Base Model:** ${data.baseModel}
- **Training Date:** ${data.trainedAt.toISOString().split("T")[0]}
- **Model ID:** ${data.modelId}
${data.trainingRunId ? `- **Training Run:** ${data.trainingRunId}` : ""}

## Performance Metrics

${
  data.benchmarkResults.length > 0
    ? `
### Benchmark Results (${data.benchmarkResults.length} runs)

| Metric | Value |
|--------|-------|
| Average P&L | ${data.metrics.avgPnl.toFixed(2)} |
| Average Accuracy | ${(data.metrics.avgAccuracy * 100).toFixed(1)}% |
| Average Optimality | ${data.metrics.avgOptimality.toFixed(1)} |

### Detailed Benchmark Results

${this.generateBenchmarkTable(data.benchmarkResults)}
`
    : "No benchmark results available yet."
}

## Training Details

### Training Data

- **Source:** Autonomous agent trajectories
- **Collection Method:** Live agent gameplay on prediction markets
- **Training Framework:** Atropos GRPO
- **Base Model:** ${data.baseModel}

### Training Procedure

This model was trained using Group Relative Policy Optimization (GRPO) via the Atropos framework on trajectories collected from autonomous agents. The training process:

1. Agents generate trajectories through market interactions
2. Trajectories are scored using RLAIF with an LLM judge based on P&L, prediction accuracy, and decision quality
3. GRPO training optimizes policy to maximize expected rewards
4. Model checkpoints are evaluated on standardized benchmarks

### Compute Infrastructure

- **Platform:** ${data.trainingRunId ? "Atropos GRPO Training" : "Local training"}
- **Training Time:** Continuous learning with hourly updates

## Intended Use

This model is designed for:

- Autonomous market decision support and simulation
- Research on RL-based trading strategies
- Benchmarking agent decision-making
- Educational purposes

**Not intended for:**
- Production trading without human oversight
- Financial advice
- Real-money trading without risk management

## Evaluation

The model is evaluated on standardized benchmarks that include:

- **Prediction Market Trading:** Betting on binary outcomes with LMSR pricing
- **Perpetual Trading:** Long/short positions on crypto perps
- **Social Interaction:** Posts, group chats, and reputation building
- **Risk Management:** Position sizing and portfolio optimization

### Metrics

- **Total P&L:** Cumulative profit/loss across all positions
- **Prediction Accuracy:** Percentage of correct market predictions
- **Optimality Score:** Alignment with theoretically optimal actions (0-100)
- **Response Time:** Decision-making latency

## Usage

### Via ${platformName}

The model can be deployed in compatible runtimes and accessed via an agent API:

\`\`\`typescript
import { agentRuntimeManager } from '@elizaos/agents';

const runtime = await agentRuntimeManager.getRuntime(agentId);
const response = await runtime.chat({
  messages: [{ role: 'user', content: 'Analyze this market...' }]
});
\`\`\`

### Direct Inference

If you have downloaded the model weights:

\`\`\`python
from transformers import AutoModelForCausalLM, AutoTokenizer

model = AutoModelForCausalLM.from_pretrained("${data.modelName}")
tokenizer = AutoTokenizer.from_pretrained("${data.modelName}")

# Use model for inference
inputs = tokenizer("Should I bet YES on this market?", return_tensors="pt")
outputs = model.generate(**inputs)
response = tokenizer.decode(outputs[0])
\`\`\`

## Limitations

- Trained on simulated market data; real-world performance may vary
- May not generalize to markets significantly different from training distribution
- Decision quality depends on market information quality
- No guarantees of profitability

## Ethical Considerations

This model is part of a research project on autonomous agents in prediction markets. Users should:

- Understand the risks of algorithmic trading
- Not rely solely on model decisions for financial outcomes
- Use appropriate risk management and position sizing
- Consider market impact and fairness implications

## Citation

\`\`\`bibtex
@model{${citationKey},
  title = {${brandName} Trading Agent},
  author = {${brandOrg}},
  year = {${new Date().getFullYear()}},
  version = {${data.version}},
  url = {https://huggingface.co/${data.modelName}}
}
\`\`\`

## Model Card Contact

For questions or issues, please open an issue on the repository.
`;

    const cardPath = path.join(outputDir, "README.md");
    await fs.writeFile(cardPath, card);
  }

  /**
   * Generate benchmark results table
   */
  private generateBenchmarkTable(results: ModelCardBenchmarkResult[]): string {
    if (results.length === 0) return "";

    let table =
      "| Benchmark | Date | P&L | Accuracy | Win Rate | Optimality |\n";
    table += "|-----------|------|-----|----------|----------|------------|\n";

    results.forEach((result) => {
      const date = new Date(result.runAt).toISOString().split("T")[0];
      table += `| ${result.benchmarkId.substring(0, 20)}... | ${date} | ${result.metrics.totalPnl.toFixed(2)} | ${(result.metrics.predictionMetrics.accuracy * 100).toFixed(1)}% | ${(result.metrics.perpMetrics.winRate * 100).toFixed(1)}% | ${result.metrics.optimalityScore.toFixed(1)} |\n`;
    });

    return table;
  }

  /**
   * Upload files to HuggingFace Hub
   * Uses shared utility for consistent upload behavior
   */
  private async uploadToHub(
    modelName: string,
    localDir: string,
    _isPrivate: boolean,
  ): Promise<number> {
    if (!this.huggingFaceToken) {
      throw new Error("HuggingFace token not configured");
    }

    try {
      // Use shared upload utility
      return await HuggingFaceUploadUtil.uploadDirectory(
        modelName,
        "model",
        localDir,
        this.huggingFaceToken,
      );
    } catch (error) {
      logger.error("Failed to upload to HuggingFace Hub", { error });

      // Provide helpful manual upload instructions
      const instructions = HuggingFaceUploadUtil.getManualUploadInstructions(
        modelName,
        "model",
        localDir,
      );

      logger.info("To upload manually:", { instructions });

      throw error;
    }
  }
}

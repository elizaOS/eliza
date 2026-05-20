#!/usr/bin/env bun

/**
 * Model Management Commands
 *
 * Commands:
 *   list           - List available trained models
 *   upload         - Upload model to HuggingFace Hub
 *   collect-data   - Collect game data for HuggingFace dataset
 *   upload-dataset - Upload dataset to HuggingFace
 *   ollama         - Manage Ollama local models (list, pull, delete)
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  benchmarkResults,
  closeDatabase,
  db,
  desc,
  eq,
  gte,
  trainedModels,
  trajectories,
} from "@feed/db";
import { HuggingFaceModelUploader } from "@feed/training";
import { getFlag, getOption, parseArgs, wantsHelp } from "../lib/args.js";
import { logger } from "../lib/logger.js";

function printHelp(): void {
  console.log(`
Model Management

USAGE:
  feed model <command> [options]

COMMANDS:
  list           List available trained models (database)
  upload         Upload model to HuggingFace Hub
  collect-data   Collect game data for HuggingFace dataset
  upload-dataset Upload dataset to HuggingFace
  ollama         Manage Ollama local models (list, pull, delete)

OPTIONS (upload):
  --model=ID            Model ID from database (required)
  --hf-name=NAME        HuggingFace model name (required)
  --description=DESC    Model description
  --private             Make model private
  --no-weights          Don't upload model weights

OPTIONS (collect-data):
  --output=DIR          Output directory (default: data/huggingface)
  --days=N              Number of days to collect (default: 30)

OPTIONS (upload-dataset):
  --source=DIR          Data source directory (default: data/huggingface)
  --repo=NAME           HuggingFace repo name (required)
  --private             Make dataset private

OPTIONS (ollama):
  list                  List all local Ollama models
  pull --name=MODEL     Pull/download a model
  delete --name=MODEL   Delete a local model
  status                Check Ollama server status

ENVIRONMENT:
  HUGGING_FACE_TOKEN or HF_TOKEN  Your HuggingFace API token
  OLLAMA_BASE_URL                 Ollama server URL (default: http://localhost:11434)

EXAMPLES:
  feed model list
  feed model collect-data --days=7
  feed model upload-dataset --repo=feedlabs/game-data
  feed model upload --model=v1 --hf-name=org/model --private
  feed model ollama list
  feed model ollama pull --name=qwen3.5:4b-instruct
  feed model ollama status

ADVANCED:
  For full RL pipeline: feed train pipeline --archetype <name>
`);
}

/**
 * Lists trained models from the database.
 *
 * Displays model ID, base model, status, creation date, HuggingFace repo, and benchmark scores.
 *
 * @internal
 */
async function listModels(): Promise<void> {
  logger.header("Trained Models");

  const models = await db
    .select()
    .from(trainedModels)
    .orderBy(desc(trainedModels.createdAt))
    .limit(20);

  if (models.length === 0) {
    console.log("No trained models found in database.");
    console.log("\nTo train a model:");
    console.log("  feed train archetype -a <archetype>");
    return;
  }

  console.log(`Found ${models.length} model(s):\n`);

  for (const model of models) {
    console.log(`${"─".repeat(60)}`);
    console.log(`Model ID:    ${model.modelId}`);
    console.log(`Base Model:  ${model.baseModel || "N/A"}`);
    console.log(`Status:      ${model.status}`);
    console.log(`Created:     ${model.createdAt.toISOString()}`);
    if (model.huggingFaceRepo) {
      console.log(`HuggingFace: ${model.huggingFaceRepo}`);
    }
    if (model.benchmarkScore !== null) {
      console.log(`Benchmark:   ${model.benchmarkScore.toFixed(2)}`);
    }
  }
  console.log(`${"─".repeat(60)}`);
}

/**
 * Collects game data for HuggingFace dataset creation.
 *
 * Gathers trajectories, benchmark results, and trained models from the database
 * and writes them to JSON files in the specified output directory.
 *
 * @param args - Parsed command-line arguments
 * @internal
 */
async function collectGameData(
  args: ReturnType<typeof parseArgs>,
): Promise<void> {
  const outputDir = getOption(args, "output") || "data/huggingface";
  const daysParam = getOption(args, "days");
  const days = daysParam ? parseInt(daysParam, 10) : 30;

  logger.header("Collecting Training Data for HuggingFace");
  console.log(`Output Directory: ${outputDir}`);
  console.log(`Days to collect: ${days}\n`);

  // Create output directory
  await fs.mkdir(outputDir, { recursive: true });

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);

  logger.step("Collecting trajectories...");
  const trajectoryResults = await db
    .select()
    .from(trajectories)
    .where(gte(trajectories.createdAt, cutoffDate))
    .orderBy(desc(trajectories.createdAt));
  console.log(`  Found ${trajectoryResults.length} trajectories`);

  logger.step("Collecting benchmark results...");
  const benchmarks = await db
    .select()
    .from(benchmarkResults)
    .where(gte(benchmarkResults.runAt, cutoffDate))
    .orderBy(desc(benchmarkResults.runAt));
  console.log(`  Found ${benchmarks.length} benchmark results`);

  logger.step("Collecting trained models...");
  const models = await db
    .select()
    .from(trainedModels)
    .where(gte(trainedModels.createdAt, cutoffDate))
    .orderBy(desc(trainedModels.createdAt));
  console.log(`  Found ${models.length} trained models`);

  // Write data files
  const timestamp = new Date().toISOString().split("T")[0];

  logger.step("Writing data files...");

  const trajectoriesPath = path.join(
    outputDir,
    `trajectories-${timestamp}.json`,
  );
  await fs.writeFile(
    trajectoriesPath,
    JSON.stringify(trajectoryResults, null, 2),
  );
  console.log(`  Wrote ${trajectoriesPath}`);

  const benchmarksPath = path.join(outputDir, `benchmarks-${timestamp}.json`);
  await fs.writeFile(benchmarksPath, JSON.stringify(benchmarks, null, 2));
  console.log(`  Wrote ${benchmarksPath}`);

  const modelsPath = path.join(outputDir, `models-${timestamp}.json`);
  await fs.writeFile(modelsPath, JSON.stringify(models, null, 2));
  console.log(`  Wrote ${modelsPath}`);

  // Write metadata
  const metadata = {
    collectedAt: new Date().toISOString(),
    cutoffDate: cutoffDate.toISOString(),
    counts: {
      trajectories: trajectoryResults.length,
      benchmarks: benchmarks.length,
      models: models.length,
    },
  };
  const metadataPath = path.join(outputDir, `metadata-${timestamp}.json`);
  await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));

  logger.success("Data collection complete!");
  console.log(`\nTotal files: 4`);
  console.log(
    `Total records: ${trajectoryResults.length + benchmarks.length + models.length}`,
  );
  console.log(`\nTo upload to HuggingFace:`);
  console.log(
    `  feed model upload-dataset --source=${outputDir} --repo=<your-repo>`,
  );
}

/**
 * Uploads collected game data to HuggingFace as a dataset.
 *
 * Creates or updates a HuggingFace dataset repository and uploads all JSON files
 * from the source directory.
 *
 * @param args - Parsed command-line arguments
 * @throws Exits process with code 1 if token missing, source invalid, or upload fails
 * @internal
 */
async function uploadDataset(
  args: ReturnType<typeof parseArgs>,
): Promise<void> {
  const sourceDir = getOption(args, "source") || "data/huggingface";
  const repoName = getOption(args, "repo");
  const isPrivate = getFlag(args, "private");

  if (!repoName) {
    logger.fail("--repo argument is required");
    printHelp();
    process.exit(1);
  }

  // Check token
  const token = process.env.HUGGING_FACE_TOKEN || process.env.HF_TOKEN;
  if (!token) {
    logger.fail("HUGGING_FACE_TOKEN or HF_TOKEN environment variable required");
    console.log("\nSet your token:");
    console.log("  export HUGGING_FACE_TOKEN=your_token_here");
    console.log(
      "\nOr get a token from: https://huggingface.co/settings/tokens",
    );
    process.exit(1);
  }

  logger.header("Uploading Dataset to HuggingFace");
  console.log(`Source: ${sourceDir}`);
  console.log(`Repo: ${repoName}`);
  console.log(`Private: ${isPrivate ? "yes" : "no"}\n`);

  // Check source directory exists
  const dirExists = await fs.access(sourceDir).then(
    () => true,
    () => false,
  );
  if (!dirExists) {
    logger.fail(`Source directory not found: ${sourceDir}`);
    console.log("\nCollect data first with:");
    console.log(`  feed model collect-data --output=${sourceDir}`);
    process.exit(1);
  }

  // Get all JSON files in source directory
  const files = await fs.readdir(sourceDir);
  const jsonFiles = files.filter((f) => f.endsWith(".json"));

  if (jsonFiles.length === 0) {
    logger.fail("No JSON files found in source directory");
    process.exit(1);
  }

  console.log(`Found ${jsonFiles.length} files to upload:`);
  for (const file of jsonFiles) {
    const stat = await fs.stat(path.join(sourceDir, file));
    console.log(`  - ${file} (${(stat.size / 1024).toFixed(1)} KB)`);
  }
  console.log("");

  const HF_API_URL = "https://huggingface.co/api";

  // Create repository using HuggingFace API
  logger.step("Creating/updating repository...");

  const createRepoResponse = await fetch(`${HF_API_URL}/repos/create`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: repoName.split("/").pop(),
      organization: repoName.includes("/") ? repoName.split("/")[0] : undefined,
      type: "dataset",
      private: isPrivate,
    }),
  });

  if (createRepoResponse.ok) {
    console.log(`  Created repository: ${repoName}`);
  } else if (createRepoResponse.status === 409) {
    console.log(`  Using existing repository: ${repoName}`);
  } else {
    const errorText = await createRepoResponse.text();
    logger.fail(`Failed to create repository: ${errorText}`);
    process.exit(1);
  }

  // Upload files
  logger.step("Uploading files...");

  for (const file of jsonFiles) {
    const filePath = path.join(sourceDir, file);
    const content = await fs.readFile(filePath, "utf-8");

    const uploadResponse = await fetch(
      `${HF_API_URL}/datasets/${repoName}/upload/main/${file}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: content,
      },
    );

    if (uploadResponse.ok) {
      console.log(`  Uploaded: ${file}`);
    } else {
      const errorText = await uploadResponse.text();
      logger.warn(`  Failed to upload ${file}: ${errorText}`);
    }
  }

  logger.success("Dataset upload complete!");
  console.log(`\n🔗 Dataset URL: https://huggingface.co/datasets/${repoName}`);
}

/**
 * Uploads a trained model to HuggingFace Hub.
 *
 * Finds the model in the database, uploads it using HuggingFaceModelUploader,
 * and updates the database with the HuggingFace repository name.
 *
 * @param args - Parsed command-line arguments
 * @throws Exits process with code 1 if model not found, token missing, or upload fails
 * @internal
 */
async function uploadModel(args: ReturnType<typeof parseArgs>): Promise<void> {
  const modelId = getOption(args, "model");
  const hfModelName = getOption(args, "hf-name");
  const description = getOption(args, "description");
  const isPrivate = getFlag(args, "private");
  const includeWeights = !getFlag(args, "no-weights");

  if (!modelId || !hfModelName) {
    logger.fail("--model and --hf-name arguments are required");
    printHelp();
    process.exit(1);
  }

  // Check token
  if (!process.env.HUGGING_FACE_TOKEN && !process.env.HF_TOKEN) {
    logger.fail("HUGGING_FACE_TOKEN or HF_TOKEN environment variable required");
    console.log("\nSet your token:");
    console.log("  export HUGGING_FACE_TOKEN=your_token_here");
    console.log(
      "\nOr get a token from: https://huggingface.co/settings/tokens",
    );
    process.exit(1);
  }

  logger.header("HuggingFace Model Upload");

  console.log(`Model ID: ${modelId}`);
  console.log(`HuggingFace Name: ${hfModelName}`);
  console.log(`Private: ${isPrivate ? "yes" : "no"}`);
  console.log(`Include Weights: ${includeWeights ? "yes" : "no"}\n`);

  // Check if model exists
  const modelResults = await db
    .select()
    .from(trainedModels)
    .where(eq(trainedModels.modelId, modelId))
    .limit(1);
  const model = modelResults[0];

  if (!model) {
    logger.fail(`Model not found: ${modelId}`);
    console.log("\nAvailable models:");
    const availableModels = await db
      .select()
      .from(trainedModels)
      .orderBy(desc(trainedModels.createdAt))
      .limit(5);
    for (const m of availableModels) {
      console.log(`  - ${m.modelId}`);
    }
    process.exit(1);
  }

  logger.success(`Found model: ${model.modelId}`);
  console.log(`  Base model: ${model.baseModel}`);
  console.log(`  Status: ${model.status}`);
  console.log(`  Created: ${model.createdAt.toISOString()}`);

  // Upload to HuggingFace
  logger.step("Uploading to HuggingFace...");

  const uploader = new HuggingFaceModelUploader();

  const result = await uploader.uploadModel({
    modelId,
    modelName: hfModelName,
    description: description || `Feed RL agent model: ${modelId}`,
    private: isPrivate,
    includeWeights,
  });

  if (result.success && result.modelUrl) {
    logger.success("Upload complete!");
    console.log(`\n🔗 Model URL: ${result.modelUrl}`);

    // Update database with HuggingFace repo
    await db
      .update(trainedModels)
      .set({ huggingFaceRepo: hfModelName })
      .where(eq(trainedModels.modelId, modelId));
  } else {
    logger.fail(`Upload failed: ${result.error || "Unknown error"}`);
    process.exit(1);
  }
}

// ============================================================================
// Ollama Management Commands
// ============================================================================

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";

interface OllamaModel {
  name: string;
  size: number;
  digest: string;
  modified_at: string;
  details?: {
    format?: string;
    family?: string;
    parameter_size?: string;
    quantization_level?: string;
  };
}

/**
 * Lists all Ollama models installed locally.
 *
 * @internal
 */
async function ollamaList(): Promise<void> {
  logger.header("Ollama Models");

  const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    logger.fail(`Ollama API error: ${response.status}`);
    process.exit(1);
  }

  const data = (await response.json()) as { models?: OllamaModel[] };
  const models = data.models || [];

  if (models.length === 0) {
    console.log("No models installed.\n");
    console.log("To install a model:");
    console.log("  feed model ollama pull --name=qwen3.5:4b-instruct");
    console.log("  ollama pull qwen3.5:4b-instruct");
    return;
  }

  console.log(`Found ${models.length} model(s):\n`);

  for (const model of models) {
    const sizeGB = (model.size / 1024 / 1024 / 1024).toFixed(2);
    const modified = new Date(model.modified_at).toLocaleDateString();

    console.log(`${"─".repeat(60)}`);
    console.log(`Model:     ${model.name}`);
    console.log(`Size:      ${sizeGB} GB`);
    console.log(`Modified:  ${modified}`);
    if (model.details) {
      if (model.details.parameter_size) {
        console.log(`Params:    ${model.details.parameter_size}`);
      }
      if (model.details.quantization_level) {
        console.log(`Quant:     ${model.details.quantization_level}`);
      }
    }
  }
  console.log(`${"─".repeat(60)}`);

  // Show archetype-specific models
  const archetypeModels = models.filter((m) => m.name.startsWith("feed-"));
  if (archetypeModels.length > 0) {
    console.log("\n🎯 Feed Trained Models:");
    for (const model of archetypeModels) {
      const archetype = model.name.replace("feed-", "").replace(":latest", "");
      console.log(`  - ${archetype}: ${model.name}`);
    }
  }
}

/**
 * Pulls/downloads an Ollama model from the registry.
 *
 * @param args - Parsed command-line arguments
 * @internal
 */
async function ollamaPull(args: ReturnType<typeof parseArgs>): Promise<void> {
  const modelName = getOption(args, "name");

  if (!modelName) {
    logger.fail("--name is required");
    console.log("\nExample: feed model ollama pull --name=qwen3.5:4b-instruct");
    process.exit(1);
  }

  logger.header(`Pulling Model: ${modelName}`);

  console.log("Downloading... (this may take a while)\n");

  const response = await fetch(`${OLLAMA_BASE_URL}/api/pull`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: modelName, stream: false }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    logger.fail(`Failed to pull model: ${errorText}`);
    process.exit(1);
  }

  const result = (await response.json()) as { status?: string };
  logger.success(`Model ${modelName} pulled successfully`);
  console.log(`Status: ${result.status || "completed"}`);

  // Verify the model is available
  console.log("\nVerifying model...");
  await ollamaList();
}

/**
 * Deletes a local Ollama model.
 *
 * @param args - Parsed command-line arguments
 * @internal
 */
async function ollamaDelete(args: ReturnType<typeof parseArgs>): Promise<void> {
  const modelName = getOption(args, "name");

  if (!modelName) {
    logger.fail("--name is required");
    console.log(
      "\nExample: feed model ollama delete --name=qwen3.5:4b-instruct",
    );
    process.exit(1);
  }

  logger.header(`Deleting Model: ${modelName}`);

  const response = await fetch(`${OLLAMA_BASE_URL}/api/delete`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: modelName }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    logger.fail(`Failed to delete model: ${errorText}`);
    process.exit(1);
  }

  logger.success(`Model ${modelName} deleted`);
}

/**
 * Checks Ollama server status and shows installed models.
 *
 * @internal
 */
async function ollamaStatus(): Promise<void> {
  logger.header("Ollama Status");

  console.log(`Server URL: ${OLLAMA_BASE_URL}\n`);

  const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
    signal: AbortSignal.timeout(5000),
  });

  if (response.ok) {
    const data = (await response.json()) as { models?: OllamaModel[] };
    const modelCount = data.models?.length || 0;

    logger.success("Ollama is running");
    console.log(`\n  Models installed: ${modelCount}`);

    // Check if recommended models are available
    const recommendedModels = [
      "qwen3.5:4b-instruct",
      "qwen3.5:9b-instruct",
      "llama3.2:3b",
      "mistral:7b",
    ];

    const modelNames = data.models?.map((m) => m.name) || [];
    console.log("\n  Recommended models:");
    for (const model of recommendedModels) {
      const installed = modelNames.some((m) =>
        m.includes(model.split(":")[0] ?? ""),
      );
      console.log(`    ${installed ? "✅" : "❌"} ${model}`);
    }

    if (modelCount === 0) {
      console.log("\n📥 To install the default model:");
      console.log("  feed model ollama pull --name=qwen3.5:4b-instruct");
    }
  } else {
    logger.fail(`Ollama returned status ${response.status}`);
  }
}

/**
 * Routes Ollama subcommands to appropriate handlers.
 *
 * @param args - Parsed command-line arguments
 * @internal
 */
async function runOllamaCommand(
  args: ReturnType<typeof parseArgs>,
): Promise<void> {
  const subCommand = args.positional[0] || "status";

  switch (subCommand) {
    case "list":
      await ollamaList();
      break;
    case "pull":
      await ollamaPull(args);
      break;
    case "delete":
      await ollamaDelete(args);
      break;
    case "status":
      await ollamaStatus();
      break;
    default:
      logger.fail(`Unknown ollama command: ${subCommand}`);
      console.log("\nAvailable commands: list, pull, delete, status");
      process.exit(1);
  }
}

/**
 * Main entry point for model domain commands.
 *
 * Routes to appropriate sub-command handlers and ensures database cleanup.
 *
 * @param args - Raw command-line arguments for the model domain
 */
export async function runModelCommand(args: string[]): Promise<void> {
  const parsed = parseArgs(args);

  if (wantsHelp(parsed)) {
    printHelp();
    process.exit(0);
  }

  // Commands that don't need database
  const noDatabaseCommands = ["ollama", "upload-dataset"];

  const needsDatabase = !noDatabaseCommands.includes(parsed.command || "");

  try {
    switch (parsed.command) {
      case "list":
        await listModels();
        break;

      case "upload":
        await uploadModel(parsed);
        break;

      case "collect-data":
        await collectGameData(parsed);
        break;

      case "upload-dataset":
        await uploadDataset(parsed);
        break;

      case "ollama":
        await runOllamaCommand(parsed);
        break;

      default:
        if (parsed.command) {
          logger.fail(`Unknown command: ${parsed.command}`);
        }
        printHelp();
        process.exit(parsed.command ? 1 : 0);
    }
  } finally {
    if (needsDatabase) {
      await closeDatabase();
    }
  }
}

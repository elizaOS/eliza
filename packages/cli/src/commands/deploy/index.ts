/**
 * Deploy Command - Deploy ElizaOS projects to Cloudflare Containers
 */

import { Command } from "commander";
import { handleError } from "@/src/utils";
import { deployProject } from "./actions/deploy";
import type { DeployOptions } from "./types";

export const deploy = new Command()
  .name("deploy")
  .description("Deploy ElizaOS project to Cloudflare Containers")
  .option("-n, --name <name>", "Name for the deployment")
  .option(
    "-p, --port <port>",
    "Port the container listens on",
    (value) => parseInt(value, 10),
    3000,
  )
  .option(
    "-m, --max-instances <count>",
    "Maximum number of container instances",
    (value) => parseInt(value, 10),
    1,
  )
  .option("-k, --api-key <key>", "ElizaOS Cloud API key")
  .option(
    "-u, --api-url <url>",
    "ElizaOS Cloud API URL",
    "https://elizacloud.ai",
  )
  .option(
    "-e, --env <KEY=VALUE>",
    "Environment variable (can be specified multiple times)",
    (value, previous: string[]) => {
      return previous.concat([value]);
    },
    [],
  )
  .option(
    "--skip-artifact",
    "Skip artifact creation and use existing artifact",
  )
  .option(
    "--artifact-path <path>",
    "Path to existing artifact to deploy",
  )
  .action(async (options: DeployOptions) => {
    try {
      // Validate numeric options
      if (isNaN(options.port!) || options.port! < 1 || options.port! > 65535) {
        console.error("❌ Error: Port must be a number between 1 and 65535");
        process.exit(1);
      }

      if (isNaN(options.maxInstances!) || options.maxInstances! < 1 || options.maxInstances! > 10) {
        console.error("❌ Error: Max instances must be a number between 1 and 10");
        process.exit(1);
      }

      const result = await deployProject(options);

      if (!result.success) {
        console.error(`\n❌ Deployment failed: ${result.error}\n`);
        process.exit(1);
      }

      console.log("\n✅ Deployment completed successfully!\n");

      if (result.containerId) {
        console.log(`Container ID: ${result.containerId}`);
      }

      if (result.workerId) {
        console.log(`Worker ID: ${result.workerId}`);
      }

      if (result.url) {
        console.log(`URL: ${result.url}`);
      }

      console.log("\n");
    } catch (error: unknown) {
      handleError(error);
      process.exit(1);
    }
  });

export * from "./types";


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
  .option("-p, --port <port>", "Port the container listens on", "3000")
  .option(
    "-m, --max-instances <count>",
    "Maximum number of container instances",
    "1",
  )
  .option("-k, --api-key <key>", "ElizaOS Cloud API key")
  .option(
    "-u, --api-url <url>",
    "ElizaOS Cloud API URL",
    "https://eliza.cloud",
  )
  .option("-d, --dockerfile <path>", "Path to Dockerfile", "Dockerfile")
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
      // Parse numeric options
      const parsedOptions: DeployOptions = {
        ...options,
        port: options.port ? parseInt(options.port.toString(), 10) : 3000,
        maxInstances: options.maxInstances
          ? parseInt(options.maxInstances.toString(), 10)
          : 1,
        skipArtifact: (options as any).skipArtifact,
        artifactPath: (options as any).artifactPath,
      };

      const result = await deployProject(parsedOptions);

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


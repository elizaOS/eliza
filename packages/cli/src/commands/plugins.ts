import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { copyTemplate } from "@/src/utils/copy-template";
import { getConfig } from "@/src/utils/get-config";
import {
	branchExists,
	createBranch,
	createPullRequest,
	forkExists,
	forkRepository,
	getFileContent,
	getGitHubCredentials,
	updateFile,
} from "@/src/utils/github";
import { handleError } from "@/src/utils/handle-error";
import { installPlugin } from "@/src/utils/install-plugin";
import { ensurePluginEnvRequirements } from "@/src/utils/plugin-env";
import { publishToGitHub, publishToNpm, testPublishToGitHub, testPublishToNpm } from "@/src/utils/plugin-publisher";
import {
	getPluginRepository,
	getRegistryIndex,
	getRegistrySettings,
	initializeDataDir,
	listPluginsByType,
	saveRegistrySettings,
	setGitHubToken,
	validateDataDir,
} from "@/src/utils/registry/index";
import { runBunCommand } from "@/src/utils/run-bun";
import { logger } from "@elizaos/core";
import chalk from "chalk";
import { Command } from "commander";
import { execa } from "execa";
import prompts from "prompts";

export const plugins = new Command()
	.name("plugins")
	.description("manage ElizaOS plugins");

plugins
	.command("list")
	.description("list available plugins")
	.option("-t, --type <type>", "filter by type (adapter, client, plugin)")
	.action(async (opts) => {
		try {
			const registry = await getRegistryIndex();
			const plugins = Object.keys(registry)
				.filter((name) => !opts.type || name.includes(opts.type))
				.sort();

			logger.info("\nAvailable plugins:");
			for (const plugin of plugins) {
				logger.info(`  ${plugin}`);
			}
			logger.info("");
		} catch (error) {
			handleError(error);
		}
	});

plugins
	.command("add")
	.description("add a plugin")
	.argument("<plugin>", "plugin name")
	.option("--no-env-prompt", "Skip prompting for environment variables")
	.action(async (plugin, opts) => {
		try {
			const cwd = process.cwd();

			const config = await getConfig(cwd);
			if (!config) {
				logger.error("No project.json found. Please run init first.");
				process.exit(1);
			}

			const repo = await getPluginRepository(plugin);

			if (!repo) {
				logger.error(`Plugin ${plugin} not found in registry`);
				process.exit(1);
			}

			// Add to config
			if (!config.plugins.installed.includes(plugin)) {
				config.plugins.installed.push(plugin);
			}

			// Install from GitHub
			logger.info(`Installing ${plugin}...`);
			await installPlugin(repo, cwd);

			// Ensure that the required environment variables are set
			if (opts.envPrompt !== false) {
				await ensurePluginEnvRequirements(plugin, true);
			}

			logger.success(`Successfully installed ${plugin}`);
		} catch (error) {
			handleError(error);
		}
	});

plugins
	.command("remove")
	.description("remove a plugin")
	.argument("<plugin>", "plugin name")
	.action(async (plugin, _opts) => {
		try {
			const cwd = process.cwd();

			const config = await getConfig(cwd);
			if (!config) {
				logger.error("No project.json found. Please run init first.");
				process.exit(1);
			}

			// Remove from config
			config.plugins.installed = config.plugins.installed.filter(
				(p) => p !== plugin,
			);

			// Uninstall package
			logger.info(`Removing ${plugin}...`);
			await execa("bun", ["remove", plugin], {
				cwd,
				stdio: "inherit",
			});

			logger.success(`Successfully removed ${plugin}`);
		} catch (error) {
			handleError(error);
		}
	});

plugins
	.command("update")
	.description("update plugins")
	.option("-p, --plugin <plugin>", "specific plugin to update")
	.action(async (opts) => {
		try {
			const cwd = process.cwd();

			const config = await getConfig(cwd);
			if (!config) {
				logger.error("No project.json found. Please run init first.");
				process.exit(1);
			}

			const _registry = await getRegistryIndex();
			const plugins = opts.plugin ? [opts.plugin] : config.plugins.installed;

			for (const plugin of plugins) {
				const repo = await getPluginRepository(plugin);
				if (!repo) {
					logger.warn(`Plugin ${plugin} not found in registry, skipping`);
					continue;
				}

				logger.info(`Updating ${plugin}...`);
				await execa("bun", ["update", plugin], {
					cwd,
					stdio: "inherit",
				});
			}

			logger.success("Plugins updated successfully");
		} catch (error) {
			handleError(error);
		}
	});

plugins
	.command("create")
	.description("create a new plugin")
	.option("-d, --dir <dir>", "installation directory", ".")
	.action(async (opts) => {
		try {
			// Prompt for plugin name
			const { name } = await prompts({
				type: "text",
				name: "name",
				message: "What would you like to name your plugin?",
				validate: (value) => value.length > 0 || "Plugin name is required",
			});

			if (!name) {
				process.exit(0);
			}

			// Set up target directory
			const targetDir =
				opts.dir === "." ? path.resolve(name) : path.resolve(opts.dir);

			// Create or check directory
			if (!existsSync(targetDir)) {
				await fs.mkdir(targetDir, { recursive: true });
			} else {
				const files = await fs.readdir(targetDir);
				const isEmpty =
					files.length === 0 || files.every((f) => f.startsWith("."));

				if (!isEmpty) {
					const { proceed } = await prompts({
						type: "confirm",
						name: "proceed",
						message: "Directory is not empty. Continue anyway?",
						initial: false,
					});

					if (!proceed) {
						process.exit(0);
					}
				}
			}

			const pluginName = name.startsWith("@elizaos/plugin-")
				? name
				: `@elizaos/plugin-${name}`;

			// Copy plugin template
			await copyTemplate("plugin", targetDir, pluginName);

			// Install dependencies
			logger.info("Installing dependencies...");
			try {
				await runBunCommand(["install"], targetDir);
				logger.success("Dependencies installed successfully!");
			} catch (_error) {
				logger.warn(
					"Failed to install dependencies automatically. Please run 'bun install' manually.",
				);
			}

			logger.success("Plugin created successfully!");
			logger.info(`\nNext steps:
1. ${chalk.cyan(`cd ${name}`)} to navigate to your plugin directory
2. Update the plugin code in ${chalk.cyan("src/index.ts")} 
3. Run ${chalk.cyan("bun dev")} to start development
4. Run ${chalk.cyan("bun build")} to build your plugin`);
		} catch (error) {
			handleError(error);
		}
	});

plugins
	.command("deploy")
	.description("deploy a plugin to GitHub")
	.option(
		"-r, --registry <registry>",
		"target registry",
		"elizaos-plugins/registry",
	)
	.option("-n, --npm", "publish to npm instead of GitHub", false)
	.action(async (opts) => {
		try {
			const cwd = process.cwd();

			// Check if this is a plugin directory
			const packageJsonPath = path.join(cwd, "package.json");
			if (!existsSync(packageJsonPath)) {
				logger.error("No package.json found in current directory.");
				process.exit(1);
			}

			// Read package.json
			const packageJsonContent = await fs.readFile(packageJsonPath, "utf-8");
			const packageJson = JSON.parse(packageJsonContent);

			if (!packageJson.name || !packageJson.version) {
				logger.error("Invalid package.json: missing name or version.");
				process.exit(1);
			}

			// Check if it's an ElizaOS plugin
			if (!packageJson.name.includes("plugin-")) {
				logger.warn(
					"This doesn't appear to be an ElizaOS plugin. Package name should include 'plugin-'.",
				);
				const { proceed } = await prompts({
					type: "confirm",
					name: "proceed",
					message: "Proceed anyway?",
					initial: false,
				});

				if (!proceed) {
					process.exit(0);
				}
			}

			// Get CLI version for runtime compatibility
			const cliPackageJsonPath = path.resolve(
				path.dirname(fileURLToPath(import.meta.url)),
				'../package.json'
			);

			let cliVersion = '0.0.0';
			try {
				const cliPackageJsonContent = await fs.readFile(
					cliPackageJsonPath,
					"utf-8",
				);
				const cliPackageJson = JSON.parse(cliPackageJsonContent);
				cliVersion = cliPackageJson.version || '0.0.0';
			} catch (error) {
				logger.warn('Could not determine CLI version, using 0.0.0');
			}

			// Handle npm publishing if selected
			if (opts.npm) {
				logger.info("Publishing to npm...");

				// Check if logged in to npm
				try {
					await execa("npm", ["whoami"], { stdio: "inherit" });
				} catch (error) {
					logger.error("Not logged in to npm. Please run 'npm login' first.");
					process.exit(1);
				}

				// Build the package
				logger.info("Building package...");
				await execa("npm", ["run", "build"], { cwd, stdio: "inherit" });

				// Publish to npm
				logger.info("Publishing to npm...");
				await execa("npm", ["publish"], { cwd, stdio: "inherit" });

				logger.success(
					`Successfully published ${packageJson.name}@${packageJson.version} to npm`,
				);
				return;
			}

			// GitHub deployment flow
			logger.info("Deploying to GitHub...");

			// Get or prompt for GitHub credentials
			let credentials = await getGitHubCredentials();
			if (!credentials) {
				logger.info("\nGitHub credentials required for publishing.");
				logger.info("Please enter your GitHub credentials:\n");

				// wait 10 ms
				await new Promise((resolve) => setTimeout(resolve, 10));
				
				const newCredentials = await getGitHubCredentials();
				if (!newCredentials) {
					process.exit(1);
				}
				
				credentials = newCredentials;
			}

			// Parse registry option (format: owner/repo)
			const [registryOwner, registryRepo] = opts.registry.split("/");
			if (!registryOwner || !registryRepo) {
				logger.error("Invalid registry format. Expected 'owner/repo'.");
				process.exit(1);
			}

			const registryFullName = `${registryOwner}/${registryRepo}`;

			// Check if the user has a fork of the registry
			logger.info(`Checking for fork of ${registryFullName}...`);
			const hasFork = await forkExists(
				credentials.token,
				registryOwner,
				registryRepo,
				credentials.username,
			);

			// Fork the registry if needed
			let forkFullName: string;
			if (!hasFork) {
				logger.info(`Creating fork of ${registryFullName}...`);
				const fork = await forkRepository(
					credentials.token,
					registryOwner,
					registryRepo,
				);

				if (!fork) {
					logger.error("Failed to fork registry repository.");
					process.exit(1);
				}

				forkFullName = fork;
			} else {
				forkFullName = `${credentials.username}/${registryRepo}`;
				logger.info(`Using existing fork: ${forkFullName}`);
			}

			// Create version-specific branch name
			const branchName = `plugin-${packageJson.name.replace(/^@elizaos\//, "")}-${packageJson.version}`;

			// Check if branch already exists
			const branchAlreadyExists = await branchExists(
				credentials.token,
				credentials.username,
				registryRepo,
				branchName,
			);

			if (branchAlreadyExists) {
				logger.warn(`Branch ${branchName} already exists.`);
				const { proceed } = await prompts({
					type: "confirm",
					name: "proceed",
					message:
						"Use existing branch? This might overwrite previous changes.",
					initial: false,
				});

				if (!proceed) {
					process.exit(0);
				}
			} else {
				// Create new branch
				logger.info(`Creating branch ${branchName}...`);
				const branchCreated = await createBranch(
					credentials.token,
					credentials.username,
					registryRepo,
					branchName,
				);

				if (!branchCreated) {
					logger.error("Failed to create branch.");
					process.exit(1);
				}
			}

			// Check if package already exists in registry
			const packageIndexPath = `packages/${packageJson.name.replace(/^@elizaos\//, "")}.json`;
			const existingPackageContent = await getFileContent(
				credentials.token,
				registryOwner,
				registryRepo,
				packageIndexPath,
			);

			let packageData;
			if (existingPackageContent) {
				// Parse existing package data
				packageData = JSON.parse(existingPackageContent);
				logger.info(`Found existing package data: ${packageJson.name}`);

				// Check if version already exists
				if (packageData.versions?.includes(packageJson.version)) {
					logger.error(
						`Version ${packageJson.version} already exists in registry.`,
					);
					logger.error(
						"Please increment your package version before deploying.",
					);
					process.exit(1);
				}

				// Add new version
				packageData.versions = packageData.versions || [];
				packageData.versions.push(packageJson.version);
				packageData.latestVersion = packageJson.version;
				packageData.runtimeVersion = cliVersion;
			} else {
				// Create new package data
				logger.info(`Creating new package entry for ${packageJson.name}`);
				packageData = {
					name: packageJson.name,
					description: packageJson.description || "",
					author: packageJson.author || "",
					repository: packageJson.repository?.url || "",
					versions: [packageJson.version],
					latestVersion: packageJson.version,
					runtimeVersion: cliVersion,
					maintainer: credentials.username,
				};
			}

			// Update package index file
			logger.info(`Updating package index for ${packageJson.name}...`);
			const packageIndexUpdated = await updateFile(
				credentials.token,
				credentials.username,
				registryRepo,
				packageIndexPath,
				JSON.stringify(packageData, null, 2),
				`Update ${packageJson.name} to version ${packageJson.version}`,
				branchName,
			);

			if (!packageIndexUpdated) {
				logger.error("Failed to update package index.");
				process.exit(1);
			}

			// Create or update main registry index
			const registryIndexPath = "index.json";
			const existingRegistryContent =
				(await getFileContent(
					credentials.token,
					credentials.username,
					registryRepo,
					registryIndexPath,
					branchName,
				)) ||
				(await getFileContent(
					credentials.token,
					registryOwner,
					registryRepo,
					registryIndexPath,
				));

			let registryData: Record<string, string> = {};
			if (existingRegistryContent) {
				registryData = JSON.parse(existingRegistryContent);
			}

			// Extract repository URL from package.json
			let repoUrl = packageJson.repository?.url || "";
			if (repoUrl.startsWith("git+")) {
				repoUrl = repoUrl.substring(4);
			}
			if (repoUrl.endsWith(".git")) {
				repoUrl = repoUrl.slice(0, -4);
			}

			// Fallback to GitHub URL based on username
			if (!repoUrl) {
				repoUrl = `https://github.com/${registryOwner}/${packageJson.name.replace(/^@elizaos\//, "")}`;
			}

			// Update registry index
			registryData[packageJson.name] = repoUrl;

			// Sort registry data alphabetically by key
			const sortedRegistryData: Record<string, string> = {};
			Object.keys(registryData)
				.sort()
				.forEach((key) => {
					sortedRegistryData[key] = registryData[key];
				});

			logger.info("Updating registry index...");
			const registryIndexUpdated = await updateFile(
				credentials.token,
				credentials.username,
				registryRepo,
				registryIndexPath,
				JSON.stringify(sortedRegistryData, null, 2),
				`Add ${packageJson.name}@${packageJson.version} to registry`,
				branchName,
			);

			if (!registryIndexUpdated) {
				logger.error("Failed to update registry index.");
				process.exit(1);
			}

			// Create pull request
			logger.info("Creating pull request...");
			const pullRequestCreated = await createPullRequest(
				credentials.token,
				registryOwner,
				registryRepo,
				`Add ${packageJson.name}@${packageJson.version} to registry`,
				`This PR adds ${packageJson.name} version ${packageJson.version} to the registry.
				
				- Package name: ${packageJson.name}
				- Version: ${packageJson.version}
				- Runtime version: ${cliVersion}
				- Description: ${packageJson.description || "No description provided"}
				- Repository: ${repoUrl}
				
				Submitted by: @${credentials.username}`,
				`${credentials.username}:${branchName}`,
				"main",
			);

			if (!pullRequestCreated) {
				logger.error("Failed to create pull request.");
				process.exit(1);
			}

			logger.success(
				`Successfully created pull request for ${packageJson.name}@${packageJson.version}`,
			);
			logger.info(
				`Your plugin will be available in the registry after the PR is merged: ${pullRequestCreated}`,
			);
		} catch (error) {
			handleError(error);
		}
	});

plugins
	.command("publish")
	.description("publish a plugin to the registry")
	.option("-r, --registry <registry>", "target registry", "elizaos/registry")
	.option("-n, --npm", "publish to npm", false)
	.option("-t, --test", "test publish process without making changes", false)
	.action(async (opts) => {
		try {
			const cwd = process.cwd();

			// Validate data directory and settings
			const isValid = await validateDataDir();
			if (!isValid) {
				logger.info("\nGitHub credentials required for publishing.");
				logger.info("You'll need a GitHub Personal Access Token with these scopes:");
				logger.info("  * repo (for repository access)");
				logger.info("  * read:org (for organization access)");
				logger.info("  * workflow (for workflow access)\n");
				
				// Initialize data directory first
				await initializeDataDir();
				
				// Use the built-in credentials function
				const credentials = await getGitHubCredentials();
				if (!credentials) {
					logger.error("GitHub credentials setup cancelled.");
					process.exit(1);
				}
				
				// Revalidate after saving credentials
				const revalidated = await validateDataDir();
				if (!revalidated) {
					logger.error("Failed to validate credentials after saving.");
					process.exit(1);
				}
			}

			// Check if this is a plugin directory
			const packageJsonPath = path.join(cwd, "package.json");
			if (!existsSync(packageJsonPath)) {
				logger.error("No package.json found in current directory.");
				process.exit(1);
			}

			// Read package.json
			const packageJsonContent = await fs.readFile(packageJsonPath, "utf-8");
			const packageJson = JSON.parse(packageJsonContent);

			if (!packageJson.name || !packageJson.version) {
				logger.error("Invalid package.json: missing name or version.");
				process.exit(1);
			}

			// Check if it's an ElizaOS plugin
			if (!packageJson.name.includes("plugin-")) {
				logger.warn(
					"This doesn't appear to be an ElizaOS plugin. Package name should include 'plugin-'.",
				);
				const { proceed } = await prompts({
					type: "confirm",
					name: "proceed",
					message: "Proceed anyway?",
					initial: false,
				});

				if (!proceed) {
					process.exit(0);
				}
			}

			// Get CLI version for runtime compatibility
			const cliPackageJsonPath = path.resolve(
				path.dirname(fileURLToPath(import.meta.url)),
				'../package.json'
			);

			let cliVersion = '0.0.0';
			try {
				const cliPackageJsonContent = await fs.readFile(
					cliPackageJsonPath,
					"utf-8",
				);
				const cliPackageJson = JSON.parse(cliPackageJsonContent);
				cliVersion = cliPackageJson.version || '0.0.0';
			} catch (error) {
				logger.warn('Could not determine CLI version, using 0.0.0');
			}

			// Get or prompt for GitHub credentials
			let credentials = await getGitHubCredentials();
			if (!credentials) {
				logger.info("\nGitHub credentials required for publishing.");
				logger.info("Please enter your GitHub credentials:\n");

				await new Promise((resolve) => setTimeout(resolve, 10));
				
				const newCredentials = await getGitHubCredentials();
				if (!newCredentials) {
					process.exit(1);
				}
				
				credentials = newCredentials;
			}

			// Update registry settings
			const settings = await getRegistrySettings();
			settings.defaultRegistry = opts.registry;
			settings.publishConfig = {
				registry: opts.registry,
				username: credentials.username,
				useNpm: opts.npm,
			};
			await saveRegistrySettings(settings);

			if (opts.test) {
				logger.info("Running publish tests...");

				if (opts.npm) {
					logger.info("\nTesting npm publishing:");
					const npmTestSuccess = await testPublishToNpm(cwd);
					if (!npmTestSuccess) {
						logger.error("npm publishing test failed");
						process.exit(1);
					}
				}

				logger.info("\nTesting GitHub publishing:");
				const githubTestSuccess = await testPublishToGitHub(
					cwd,
					packageJson,
					credentials.username,
				);

				if (!githubTestSuccess) {
					logger.error("GitHub publishing test failed");
					process.exit(1);
				}

				logger.success("All tests passed successfully!");
				return;
			}

			// Handle npm publishing
			if (opts.npm) {
				const success = await publishToNpm(cwd);
				if (!success) {
					process.exit(1);
				}
			}

			// Handle GitHub publishing
			const success = await publishToGitHub(
				cwd,
				packageJson,
				cliVersion,
				credentials.username,
				false,
			);

			if (!success) {
				process.exit(1);
			}

			logger.success(
				`Successfully published ${packageJson.name}@${packageJson.version}`,
			);
		} catch (error) {
			handleError(error);
		}
	});

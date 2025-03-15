import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	getGitHubCredentials
} from "@/src/utils/github";
import { handleError } from "@/src/utils/handle-error";
import { publishToGitHub, testPublishToGitHub, testPublishToNpm } from "@/src/utils/plugin-publisher";
import {
	getRegistrySettings,
	initializeDataDir,
	saveRegistrySettings,
	validateDataDir
} from "@/src/utils/registry/index";
import { logger } from "@elizaos/core";
import { Command } from "commander";
import { execa } from "execa";
import prompts from "prompts";
import { Octokit } from "@octokit/rest";
import axios from "axios";

// Registry integration constants
const REGISTRY_REPO = "elizaos/registry";
const REGISTRY_PACKAGES_PATH = "packages";
const LOCAL_REGISTRY_PATH = "packages/registry";

/**
 * Package metadata interface
 */
interface PackageMetadata {
	name: string;
	version: string;
	description: string;
	type: string;
	platform: string;
	runtimeVersion: string;
	repository: string;
	maintainers: string[];
	publishedAt: string;
	publishedBy: string;
	dependencies: Record<string, string>;
	tags: string[];
	license: string;
	npmPackage?: string;
	githubRepo?: string;
}

/**
 * Check if the current CLI version is up to date
 */
async function checkCliVersion() {
	try {
		const cliPackageJsonPath = path.resolve(
			path.dirname(fileURLToPath(import.meta.url)),
			'../package.json'
		);
		
		const cliPackageJsonContent = await fs.readFile(
			cliPackageJsonPath,
			"utf-8",
		);
		const cliPackageJson = JSON.parse(cliPackageJsonContent);
		const currentVersion = cliPackageJson.version || '0.0.0';
		
		// Check NPM for latest version
		const { stdout } = await execa("npm", ["view", "@elizaos/cli", "version"]);
		const latestVersion = stdout.trim();
		
		// Compare versions
		if (latestVersion !== currentVersion) {
			logger.warn(`You are using CLI version ${currentVersion}, but the latest is ${latestVersion}`);
			logger.info("Run 'npx @elizaos/cli update' to update to the latest version");
			
			const { update } = await prompts({
				type: "confirm",
				name: "update",
				message: "Would you like to update now before proceeding?",
				initial: false,
			});
			
			if (update) {
				logger.info("Updating CLI...");
				await execa("npx", ["@elizaos/cli", "update"], { stdio: "inherit" });
				process.exit(0);
			}
		}
		
		return currentVersion;
	} catch (error) {
		logger.warn("Could not check for CLI updates");
		return null;
	}
}

/**
 * Generate package metadata for the registry
 */
async function generatePackageMetadata(packageJson, cliVersion, username): Promise<PackageMetadata> {
	const metadata: PackageMetadata = {
		name: packageJson.name,
		version: packageJson.version,
		description: packageJson.description || "",
		type: packageJson.type || "plugin", // plugin or project
		platform: packageJson.platform || "universal", // node, browser, or universal
		runtimeVersion: cliVersion, // Compatible CLI/runtime version
		repository: packageJson.repository?.url || "",
		maintainers: packageJson.maintainers || [username],
		publishedAt: new Date().toISOString(),
		publishedBy: username,
		dependencies: packageJson.dependencies || {},
		tags: packageJson.keywords || [],
		license: packageJson.license || "UNLICENSED"
	};
	
	// Add npm or GitHub specific data
	if (packageJson.npmPackage) {
		metadata.npmPackage = packageJson.npmPackage;
	}
	
	if (packageJson.githubRepo) {
		metadata.githubRepo = packageJson.githubRepo;
	}
	
	return metadata;
}

/**
 * Check if user is a maintainer for the package
 */
function isMaintainer(packageJson, username) {
	if (!packageJson.maintainers) {
		// If no maintainers specified, the publisher becomes the first maintainer
		return true;
	}
	
	return packageJson.maintainers.includes(username);
}

/**
 * Update the registry index with the package information
 */
async function updateRegistryIndex(packageMetadata, dryRun = false) {
	try {
		const indexPath = dryRun 
			? path.join(process.cwd(), LOCAL_REGISTRY_PATH, "index.json") 
			: path.join(process.cwd(), "temp-registry", "index.json");
		
		// Create registry directory if it doesn't exist in dry run
		if (dryRun && !existsSync(path.dirname(indexPath))) {
			await fs.mkdir(path.dirname(indexPath), { recursive: true });
			// Create empty index file if it doesn't exist
			if (!existsSync(indexPath)) {
				await fs.writeFile(indexPath, JSON.stringify({
					v1: { packages: {} },
					v2: { packages: {} }
				}, null, 2));
			}
		}
		
		// Read current index
		let indexContent;
		try {
			indexContent = await fs.readFile(indexPath, "utf-8");
		} catch (error) {
			// Create default index if it doesn't exist
			indexContent = JSON.stringify({
				v1: { packages: {} },
				v2: { packages: {} }
			});
		}
		
		const index = JSON.parse(indexContent);
		
		// Update v2 section of index
		if (!index.v2) {
			index.v2 = { packages: {} };
		}
		
		if (!index.v2.packages) {
			index.v2.packages = {};
		}
		
		if (!index.v2.packages[packageMetadata.name]) {
			index.v2.packages[packageMetadata.name] = {
				name: packageMetadata.name,
				description: packageMetadata.description,
				type: packageMetadata.type,
				versions: {}
			};
		}
		
		// Update package info
		const packageInfo = index.v2.packages[packageMetadata.name];
		packageInfo.description = packageMetadata.description;
		packageInfo.type = packageMetadata.type;
		
		// Add version
		packageInfo.versions[packageMetadata.version] = {
			version: packageMetadata.version,
			runtimeVersion: packageMetadata.runtimeVersion,
			platform: packageMetadata.platform,
			publishedAt: packageMetadata.publishedAt,
			published: !dryRun
		};
		
		// Write updated index
		await fs.writeFile(indexPath, JSON.stringify(index, null, 2));
		logger.info(`Registry index ${dryRun ? "(dry run) " : ""}updated with ${packageMetadata.name}@${packageMetadata.version}`);
		
		return true;
	} catch (error) {
		logger.error(`Failed to update registry index: ${error.message}`);
		return false;
	}
}

/**
 * Save package metadata to registry
 */
async function savePackageToRegistry(packageMetadata, dryRun = false) {
	try {
		// Define paths
		const packageDir = dryRun
			? path.join(process.cwd(), LOCAL_REGISTRY_PATH, REGISTRY_PACKAGES_PATH, packageMetadata.name)
			: path.join(process.cwd(), "temp-registry", REGISTRY_PACKAGES_PATH, packageMetadata.name);
		const metadataPath = path.join(packageDir, `${packageMetadata.version}.json`);
		
		// Create directory if it doesn't exist
		await fs.mkdir(packageDir, { recursive: true });
		
		// Write metadata file
		await fs.writeFile(
			metadataPath,
			JSON.stringify(packageMetadata, null, 2)
		);
		
		logger.info(`Package metadata ${dryRun ? "(dry run) " : ""}saved to ${metadataPath}`);
		
		// Update index file
		await updateRegistryIndex(packageMetadata, dryRun);
		
		return true;
	} catch (error) {
		logger.error(`Failed to save package metadata: ${error.message}`);
		return false;
	}
}

/**
 * Fork the registry repository if needed and create pull request
 */
async function createRegistryPullRequest(packageJson, packageMetadata, username, token) {
	try {
		const octokit = new Octokit({ auth: token });
		const [registryOwner, registryRepo] = REGISTRY_REPO.split('/');
		
		// Check if user already has a fork
		logger.info("Checking for existing fork of registry...");
		let fork;
		try {
			const { data: repos } = await octokit.repos.listForUser({
				username,
				sort: "updated",
				per_page: 100
			});
			
			fork = repos.find(repo => repo.name === registryRepo);
		} catch (error) {
			logger.debug(`Error checking for existing fork: ${error.message}`);
		}
		
		// Create fork if it doesn't exist
		if (!fork) {
			logger.info(`Creating fork of ${REGISTRY_REPO}...`);
			const { data: newFork } = await octokit.repos.createFork({
				owner: registryOwner,
				repo: registryRepo
			});
			fork = newFork;
			
			// Wait for fork creation to complete
			logger.info("Waiting for fork to be ready...");
			await new Promise(resolve => setTimeout(resolve, 5000));
		}
		
		// Clone the forked repo
		const tempDir = path.join(process.cwd(), "temp-registry");
		if (existsSync(tempDir)) {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
		
		logger.info(`Cloning registry fork...`);
		await execa("git", ["clone", `https://${username}:${token}@github.com/${username}/${registryRepo}.git`, "temp-registry"], { cwd: process.cwd() });
		
		// Create a new branch
		const branchName = `plugin-${packageJson.name}-${packageJson.version}`.replace(/[^a-zA-Z0-9-_]/g, "-");
		logger.info(`Creating branch ${branchName}...`);
		await execa("git", ["checkout", "-b", branchName], { cwd: tempDir });
		
		// Save package metadata and update index
		await savePackageToRegistry(packageMetadata, false);
		
		// Commit changes
		logger.info("Committing changes...");
		await execa("git", ["add", "."], { cwd: tempDir });
		await execa("git", ["commit", "-m", `Add ${packageJson.name}@${packageJson.version}`], { cwd: tempDir });
		
		// Push branch
		logger.info("Pushing changes...");
		await execa("git", ["push", "origin", branchName], { cwd: tempDir });
		
		// Create pull request
		logger.info("Creating pull request...");
		const { data: pullRequest } = await octokit.pulls.create({
			owner: registryOwner,
			repo: registryRepo,
			title: `Add ${packageJson.name}@${packageJson.version}`,
			head: `${username}:${branchName}`,
			base: "main",
			body: `
## New Plugin/Project Submission

- Name: ${packageJson.name}
- Version: ${packageJson.version}
- Type: ${packageJson.type || "plugin"}
- Platform: ${packageJson.platform || "universal"}
- Description: ${packageJson.description || ""}
- Runtime Version: ${packageMetadata.runtimeVersion}

Submitted by: @${username}
			`
		});
		
		logger.success(`Pull request created: ${pullRequest.html_url}`);
		return pullRequest.html_url;
	} catch (error) {
		logger.error(`Failed to create pull request: ${error.message}`);
		return null;
	} finally {
		// Clean up temp directory
		try {
			const tempDir = path.join(process.cwd(), "temp-registry");
			if (existsSync(tempDir)) {
				await fs.rm(tempDir, { recursive: true, force: true });
			}
		} catch (error) {
			logger.debug(`Error cleaning up temp directory: ${error.message}`);
		}
	}
}

export const publish = new Command()
	.name("publish")
	.description("Publish a plugin or project to the registry")
	.option("-r, --registry <registry>", "target registry", "elizaos/registry")
	.option("-n, --npm", "publish to npm instead of GitHub", false)
	.option("-t, --test", "test publish process without making changes", false)
	.option("-p, --platform <platform>", "specify platform compatibility (node, browser, universal)", "universal")
	.option("--dry-run", "generate registry files locally without publishing", false)
	.option("--skip-registry", "skip publishing to the registry", false)
	.action(async (opts) => {
		try {
			const cwd = process.cwd();

			// Check for CLI updates
			const cliVersion = await checkCliVersion();

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

			// Check if this is a valid directory with package.json
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

			// Auto-detect whether this is a plugin or project
			let detectedType = 'plugin'; // Default to plugin
			
			// Check if this is a plugin or project based on package.json
			if (packageJson.agentConfig?.pluginType) {
				// Check if explicitly defined in the agentConfig section
				const pluginType = packageJson.agentConfig.pluginType.toLowerCase();
				if (pluginType.includes('plugin')) {
					detectedType = 'plugin';
					logger.info("Detected Eliza plugin in current directory");
				} else if (pluginType.includes('project')) {
					detectedType = 'project';
					logger.info("Detected Eliza project in current directory");
				}
			} else if (packageJson.eliza?.type) {
				// For backward compatibility, also check eliza.type
				if (packageJson.eliza.type === 'plugin') {
					detectedType = 'plugin';
					logger.info("Detected Eliza plugin in current directory (legacy format)");
				} else if (packageJson.eliza.type === 'project') {
					detectedType = 'project';
					logger.info("Detected Eliza project in current directory (legacy format)");
				}
			} else {
				// Use heuristics to detect the type
				// Check if name contains plugin
				if (packageJson.name.includes("plugin-")) {
					detectedType = 'plugin';
					logger.info("Detected plugin based on package name");
				} else if (packageJson.description?.toLowerCase().includes("project")) {
					detectedType = 'project';
					logger.info("Detected project based on package description");
				} else {
					// Additional heuristics from start.ts
					try {
						// If the package has a main entry, check if it exports a Project
						const mainEntry = packageJson.main;
						if (mainEntry) {
							const mainPath = path.resolve(cwd, mainEntry);
							if (existsSync(mainPath)) {
								try {
									// Try to import the module to see if it's a project or plugin
									const importedModule = await import(mainPath);
									
									// Check for project indicators (agents array or agent property)
									if (importedModule.default?.agents || importedModule.default?.agent) {
										detectedType = 'project';
										logger.info("Detected project based on exports");
									}
									// Check for plugin indicators
									else if (importedModule.default?.name && typeof importedModule.default?.init === 'function') {
										detectedType = 'plugin';
										logger.info("Detected plugin based on exports");
									}
								} catch (importError) {
									logger.debug(`Error importing module: ${importError}`);
									// Continue with default type
								}
							}
						}
					} catch (error) {
						logger.debug(`Error during type detection: ${error}`);
						// Continue with default type
					}
				}
			}

			// Validate platform option
			const validPlatforms = ['node', 'browser', 'universal'];
			if (opts.platform && !validPlatforms.includes(opts.platform)) {
				logger.error(`Invalid platform: ${opts.platform}. Valid options are: ${validPlatforms.join(', ')}`);
				process.exit(1);
			}

			// Add type and platform to package.json for publishing
			packageJson.type = detectedType;
			packageJson.platform = opts.platform;
			
			// Preserve agentConfig if it exists or create it
			if (!packageJson.agentConfig) {
				packageJson.agentConfig = {
					pluginType: detectedType === 'plugin' ? 'elizaos:plugin:1.0.0' : 'elizaos:project:1.0.0',
					pluginParameters: {}
				};
			} else if (!packageJson.agentConfig.pluginType) {
				// Ensure pluginType is set based on detection
				packageJson.agentConfig.pluginType = detectedType === 'plugin' ? 'elizaos:plugin:1.0.0' : 'elizaos:project:1.0.0';
			}

			// For plugin type, validate naming convention
			if (detectedType === 'plugin' && !packageJson.name.includes("plugin-")) {
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
				platform: opts.platform,
			};
			await saveRegistrySettings(settings);

			// Generate package metadata
			const packageMetadata = await generatePackageMetadata(packageJson, cliVersion, credentials.username);
			logger.debug("Generated package metadata:", packageMetadata);

			// Check if user is a maintainer
			const userIsMaintainer = isMaintainer(packageJson, credentials.username);
			logger.info(`User ${credentials.username} is ${userIsMaintainer ? 'a maintainer' : 'not a maintainer'} of this package`);

			// Handle dry run mode (create local registry files)
			if (opts.dryRun) {
				logger.info(`Running dry run for ${detectedType} registry publication...`);
				
				// Save package to local registry
				const success = await savePackageToRegistry(packageMetadata, true);
				
				if (success) {
					logger.success(`Dry run successful: Registry metadata generated for ${packageJson.name}@${packageJson.version}`);
					logger.info(`Files created in ${LOCAL_REGISTRY_PATH}`);
				} else {
					logger.error("Dry run failed");
					process.exit(1);
				}
				
				return;
			}

			if (opts.test) {
				logger.info(`Running ${detectedType} publish tests...`);

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

				// Test registry publishing
				if (!opts.skipRegistry) {
					logger.info("\nTesting registry publishing:");
					const registryTestSuccess = await savePackageToRegistry(packageMetadata, true);
					
					if (!registryTestSuccess) {
						logger.error("Registry publishing test failed");
						process.exit(1);
					}
				}

				logger.success("All tests passed successfully!");
				return;
			}

			// Handle actual publishing

			// Handle npm publishing
			if (opts.npm) {
				logger.info(`Publishing ${detectedType} to npm...`);

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
				
				// Add npm package info to metadata
				packageMetadata.npmPackage = packageJson.name;
			} else {
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
					`Successfully published ${detectedType} ${packageJson.name}@${packageJson.version} to GitHub`,
				);
				
				// Add GitHub repo info to metadata
				packageMetadata.githubRepo = `${credentials.username}/${packageJson.name}`;
			}
			
			// Handle registry publication
			if (!opts.skipRegistry) {
				logger.info("Publishing to registry...");
				
				if (userIsMaintainer) {
					// For maintainers, create a PR to the registry
					logger.info("Creating pull request to registry as maintainer...");
					const prUrl = await createRegistryPullRequest(
						packageJson, 
						packageMetadata, 
						credentials.username,
						credentials.token
					);
					
					if (prUrl) {
						logger.success(`Registry pull request created: ${prUrl}`);
					} else {
						logger.error("Failed to create registry pull request");
					}
				} else {
					// For non-maintainers, just show a message about how to request inclusion
					logger.info("Package published, but you're not a maintainer of this package.");
					logger.info("To include this package in the registry, please:");
					logger.info("1. Fork the registry repository at https://github.com/elizaos/registry");
					logger.info("2. Add your package metadata");
					logger.info("3. Submit a pull request to the main repository");
				}
			}

			logger.success(
				`Successfully published ${detectedType} ${packageJson.name}@${packageJson.version}`,
			);
		} catch (error) {
			handleError(error);
		}
	});


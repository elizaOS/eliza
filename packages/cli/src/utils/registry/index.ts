import {
	getLocalPackages,
	isMonorepoContext,
} from "@/src/utils/get-package-info";
import { logger } from "@/src/utils/logger";
import {
	type Registry,
	getPluginType,
	registrySchema,
} from "@/src/utils/registry/schema";
import { execa } from "execa";
import { HttpsProxyAgent } from "https-proxy-agent";
import fetch from "node-fetch";
import { z } from "zod";
import { REGISTRY_URL } from "./constants";

const agent = process.env.https_proxy
	? new HttpsProxyAgent(process.env.https_proxy)
	: undefined;

/**
 * Fetches the registry index asynchronously.
 *
 * @returns {Promise<Registry>} The registry index
 * @throws {Error} If the response from the registry is not valid JSON or if there is an error fetching the plugins
 */
export async function getRegistryIndex(): Promise<Registry> {
	try {
		const response = await fetch(REGISTRY_URL, { agent });
		// Get the response body as text first
		const text = await response.text();

		let registry: Registry;
		try {
			// validate if the response is a valid registry
			registry = registrySchema.parse(JSON.parse(text));
		} catch {
			console.error("Invalid JSON response received from registry:", text);
			throw new Error("Registry response is not valid JSON");
		}

		return registry;
	} catch (error) {
		throw new Error(`Failed to fetch plugins from registry: ${error.message}`);
	}
}

/**
 * Retrieves the repository URL for a given plugin from the registry.
 *
 * @param {string} pluginName - The name of the plugin to fetch the repository URL for.
 * @returns {Promise<string | null>} The repository URL for the plugin, or null if not found.
 * @throws {Error} If an error occurs while retrieving the repository URL.
 */
export async function getPluginRepository(
	pluginName: string,
): Promise<string | null> {
	try {
		const registry = await getRegistryIndex();
		return registry[pluginName] || null;
	} catch (error) {
		throw new Error(`Failed to get plugin repository: ${error.message}`);
	}
}

/**
 * Check if a GitHub repository has a specific branch
 */
/**
 * Check if a repository has a specific branch.
 *
 * @param {string} repoUrl - The URL of the repository to check.
 * @param {string} branchName - The name of the branch to check for.
 * @returns {Promise<boolean>} A Promise that resolves to a boolean indicating whether the branch exists in the repository.
 */
export async function repoHasBranch(
	repoUrl: string,
	branchName: string,
): Promise<boolean> {
	try {
		const { stdout } = await execa("git", [
			"ls-remote",
			"--heads",
			repoUrl,
			branchName,
		]);
		return stdout.includes(branchName);
	} catch (error) {
		logger.warn(
			`Failed to check for branch ${branchName} in ${repoUrl}: ${error.message}`,
		);
		return false;
	}
}

export async function getBestBranch(repoUrl: string): Promise<string> {
	// Check for v2 or v2-develop branches
	if (await repoHasBranch(repoUrl, "v2")) {
		return "v2";
	}
	if (await repoHasBranch(repoUrl, "v2-develop")) {
		return "v2-develop";
	}
	// Default to main branch
	return "main";
}

export async function listPluginsByType(
	type: "adapter" | "client" | "plugin",
): Promise<string[]> {
	try {
		const registry = await getRegistryIndex();
		const registryPlugins = Object.keys(registry).filter((name) =>
			name.includes(`${type}-`),
		);

		// If we're in a monorepo context, include local packages
		if (isMonorepoContext()) {
			const localPlugins = await getLocalPackages();
			const filteredLocalPlugins = localPlugins.filter((name) =>
				name.includes(`${type}-`),
			);

			// Combine and deduplicate
			return [...new Set([...registryPlugins, ...filteredLocalPlugins])];
		}

		return registryPlugins;
	} catch (error) {
		throw new Error(`Failed to list plugins: ${error.message}`);
	}
}

export async function getAvailableDatabases(): Promise<string[]> {
	try {
		return ["postgres", "pglite"];
	} catch (error) {
		throw new Error(`Failed to get available databases: ${error.message}`);
	}
}

/**
 * Attempts to get package details from the registry
 */
export async function getPackageDetails(packageName: string): Promise<{
	name: string;
	description: string;
	author: string;
	repository: string;
	versions: string[];
	latestVersion: string;
	runtimeVersion: string;
	maintainer: string;
} | null> {
	try {
		// Normalize the package name (remove @elizaos/ prefix if present)
		const normalizedName = packageName.replace(/^@elizaos\//, "");

		// Get package details from registry
		const packageUrl = `${REGISTRY_URL.replace("index.json", "")}packages/${normalizedName}.json`;

		const response = await fetch(packageUrl, { agent });
		if (response.status !== 200) {
			return null;
		}

		// Get the response body
		const text = await response.text();
		try {
			return JSON.parse(text);
		} catch {
			logger.warn(
				`Invalid JSON response received from registry for package ${packageName}:`,
				text,
			);
			return null;
		}
	} catch (error) {
		logger.warn(
			`Failed to fetch package details from registry: ${error.message}`,
		);
		return null;
	}
}

/**
 * Gets the best matching version of a plugin based on runtime version
 */
export async function getBestPluginVersion(
	packageName: string,
	runtimeVersion: string,
): Promise<string | null> {
	const packageDetails = await getPackageDetails(packageName);
	if (
		!packageDetails ||
		!packageDetails.versions ||
		packageDetails.versions.length === 0
	) {
		return null;
	}

	// If runtime version matches exactly, use the latest version
	if (packageDetails.runtimeVersion === runtimeVersion) {
		return packageDetails.latestVersion;
	}

	// Parse the runtime version for semver matching
	const [runtimeMajor, runtimeMinor, runtimePatch] = runtimeVersion
		.split(".")
		.map(Number);
	const [packageMajor, packageMinor, packagePatch] =
		packageDetails.runtimeVersion.split(".").map(Number);

	// If major version is different, warn but still return the latest
	if (runtimeMajor !== packageMajor) {
		logger.warn(
			`Plugin ${packageName} was built for runtime v${packageDetails.runtimeVersion}, but you're using v${runtimeVersion}`,
		);
		logger.warn("This may cause compatibility issues.");
		return packageDetails.latestVersion;
	}

	// If minor version is different, warn but with less severity
	if (runtimeMinor !== packageMinor) {
		logger.warn(
			`Plugin ${packageName} was built for runtime v${packageDetails.runtimeVersion}, you're using v${runtimeVersion}`,
		);
	}

	return packageDetails.latestVersion;
}

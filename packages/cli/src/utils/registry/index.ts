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

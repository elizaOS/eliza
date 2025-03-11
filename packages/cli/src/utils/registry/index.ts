import {
	getLocalPackages,
	isMonorepoContext,
} from "@/src/utils/get-package-info";
import {
	type Registry,
	getPluginType,
	registrySchema,
} from "@/src/utils/registry/schema";
import { logger } from "@elizaos/core";
import { execa } from "execa";
import { HttpsProxyAgent } from "https-proxy-agent";
import fetch from "node-fetch";
import { z } from "zod";
import { REGISTRY_URL } from "./constants";
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import dotenv from 'dotenv';
import { getGitHubCredentials } from '../github';

const ELIZA_DIR = path.join(os.homedir(), '.eliza');
const REGISTRY_SETTINGS_FILE = path.join(ELIZA_DIR, 'registrysettings.json');
const ENV_FILE = path.join(ELIZA_DIR, '.env');

const REQUIRED_ENV_VARS = ['GITHUB_TOKEN'] as const;
const REQUIRED_SETTINGS = ['defaultRegistry'] as const;

export interface RegistrySettings {
	defaultRegistry: string;
	publishConfig?: {
		registry: string;
		username?: string;
		useNpm?: boolean;
	};
}

export interface DataDirStatus {
	exists: boolean;
	env: {
		exists: boolean;
		missingKeys: string[];
		hasAllKeys: boolean;
	};
	settings: {
		exists: boolean;
		missingKeys: string[];
		hasAllKeys: boolean;
	};
}

export async function ensureElizaDir() {
	try {
		await fs.mkdir(ELIZA_DIR, { recursive: true });
	} catch (error) {
		// Directory already exists
	}
}

export async function getRegistrySettings(): Promise<RegistrySettings> {
	await ensureElizaDir();
	
	try {
		const content = await fs.readFile(REGISTRY_SETTINGS_FILE, 'utf-8');
		return JSON.parse(content);
	} catch (error) {
		// Return default settings if file doesn't exist
		return {
			defaultRegistry: 'elizaos/registry',
		};
	}
}

export async function saveRegistrySettings(settings: RegistrySettings) {
	await ensureElizaDir();
	await fs.writeFile(REGISTRY_SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

export async function getEnvVar(key: string): Promise<string | undefined> {
	try {
		const envContent = await fs.readFile(ENV_FILE, 'utf-8');
		const env = dotenv.parse(envContent);
		return env[key];
	} catch (error) {
		return undefined;
	}
}

export async function setEnvVar(key: string, value: string) {
	await ensureElizaDir();
	
	let envContent = '';
	try {
		envContent = await fs.readFile(ENV_FILE, 'utf-8');
	} catch (error) {
		// File doesn't exist yet
	}

	const env = dotenv.parse(envContent);
	env[key] = value;

	const newContent = Object.entries(env)
		.map(([k, v]) => `${k}=${v}`)
		.join('\n');

	await fs.writeFile(ENV_FILE, newContent);
}

export async function getGitHubToken(): Promise<string | undefined> {
	return getEnvVar('GITHUB_TOKEN');
}

export async function setGitHubToken(token: string) {
	await setEnvVar('GITHUB_TOKEN', token);
}

const agent = process.env.https_proxy
	? new HttpsProxyAgent(process.env.https_proxy)
	: undefined;

interface PluginMetadata {
	name: string;
	description: string;
	author: string;
	repository: string;
	versions: string[];
	latestVersion: string;
	runtimeVersion: string;
	maintainer: string;
	tags?: string[];
	categories?: string[];
}

/**
 * Fetches the registry index asynchronously.
 *
 * @returns {Promise<Registry>} The registry index
 * @throws {Error} If the response from the registry is not valid JSON or if there is an error fetching the plugins
 */
export async function getRegistryIndex(): Promise<Record<string, string>> {
	const settings = await getRegistrySettings();
	const credentials = await getGitHubCredentials();

	if (!credentials) {
		logger.error('GitHub credentials not found. Please run login first.');
		process.exit(1);
	}

	const [owner, repo] = settings.defaultRegistry.split('/');
	const url = `https://api.github.com/repos/${owner}/${repo}/contents/index.json`;

	const response = await fetch(url, {
		headers: {
			Authorization: `token ${credentials.token}`,
			Accept: 'application/vnd.github.v3.raw',
		},
	});

	if (!response.ok) {
		throw new Error(`Failed to fetch registry index: ${response.statusText}`);
	}

	const data = await response.json();
	if (typeof data !== 'object' || data === null) {
		throw new Error('Invalid registry index format');
	}

	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(data)) {
		if (typeof value === 'string') {
			result[key] = value;
		}
	}

	return result;
}

/**
 * Retrieves the repository URL for a given plugin from the registry.
 *
 * @param {string} pluginName - The name of the plugin to fetch the repository URL for.
 * @returns {Promise<string | null>} The repository URL for the plugin, or null if not found.
 * @throws {Error} If an error occurs while retrieving the repository URL.
 */
export async function getPluginRepository(pluginName: string): Promise<string | null> {
	const metadata = await getPluginMetadata(pluginName);
	return metadata?.repository || null;
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

export async function listPluginsByType(type?: string): Promise<string[]> {
	const registry = await getRegistryIndex();
	return Object.keys(registry)
		.filter((name) => !type || name.includes(type))
		.sort();
}

export async function getPluginMetadata(pluginName: string): Promise<PluginMetadata | null> {
	const settings = await getRegistrySettings();
	const credentials = await getGitHubCredentials();

	if (!credentials) {
		logger.error('GitHub credentials not found. Please run login first.');
		process.exit(1);
	}

	const [owner, repo] = settings.defaultRegistry.split('/');
	const normalizedName = pluginName.replace(/^@elizaos\//, '');
	const url = `https://api.github.com/repos/${owner}/${repo}/contents/packages/${normalizedName}.json`;

	try {
		const response = await fetch(url, {
			headers: {
				Authorization: `token ${credentials.token}`,
				Accept: 'application/vnd.github.v3.raw',
			},
		});

		if (!response.ok) {
			if (response.status === 404) {
				return null;
			}
			throw new Error(`Failed to fetch plugin metadata: ${response.statusText}`);
		}

		const data = await response.json();
		if (typeof data !== 'object' || data === null) {
			throw new Error('Invalid plugin metadata format');
		}

		const metadata = data as PluginMetadata;
		if (!metadata.name || !metadata.description || !metadata.author || !metadata.repository ||
			!metadata.versions || !metadata.latestVersion || !metadata.runtimeVersion || !metadata.maintainer) {
			throw new Error('Invalid plugin metadata: missing required fields');
		}

		return metadata;
	} catch (error) {
		logger.error('Failed to fetch plugin metadata:', error);
		return null;
	}
}

export async function getPluginVersion(pluginName: string, version?: string): Promise<string | null> {
	const metadata = await getPluginMetadata(pluginName);
	
	if (!metadata) {
		return null;
	}

	if (!version) {
		return metadata.latestVersion;
	}

	if (!metadata.versions.includes(version)) {
		return null;
	}

	return version;
}

export async function getPluginTags(pluginName: string): Promise<string[]> {
	const metadata = await getPluginMetadata(pluginName);
	return metadata?.tags || [];
}

export async function getPluginCategories(pluginName: string): Promise<string[]> {
	const metadata = await getPluginMetadata(pluginName);
	return metadata?.categories || [];
}

export async function getAvailableDatabases(): Promise<string[]> {
	const registry = await getRegistryIndex();
	return Object.keys(registry)
		.filter((name) => name.includes('database-'))
		.sort();
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

export async function checkDataDir(): Promise<DataDirStatus> {
	const status: DataDirStatus = {
		exists: false,
		env: {
			exists: false,
			missingKeys: [...REQUIRED_ENV_VARS],
			hasAllKeys: false,
		},
		settings: {
			exists: false,
			missingKeys: [...REQUIRED_SETTINGS],
			hasAllKeys: false,
		},
	};

	// Check if data directory exists
	try {
		await fs.access(ELIZA_DIR);
		status.exists = true;
	} catch {
		return status;
	}

	// Check .env file
	try {
		const envContent = await fs.readFile(ENV_FILE, 'utf-8');
		const env = dotenv.parse(envContent);
		status.env.exists = true;
		status.env.missingKeys = REQUIRED_ENV_VARS.filter(key => !env[key]);
		status.env.hasAllKeys = status.env.missingKeys.length === 0;
	} catch {
		// .env file doesn't exist or can't be read
	}

	// Check settings file
	try {
		const settingsContent = await fs.readFile(REGISTRY_SETTINGS_FILE, 'utf-8');
		const settings = JSON.parse(settingsContent);
		status.settings.exists = true;
		status.settings.missingKeys = REQUIRED_SETTINGS.filter(key => !(key in settings));
		status.settings.hasAllKeys = status.settings.missingKeys.length === 0;
	} catch {
		// settings file doesn't exist or can't be read
	}

	return status;
}

export async function initializeDataDir(): Promise<void> {
	await ensureElizaDir();

	// Initialize .env if it doesn't exist
	try {
		await fs.access(ENV_FILE);
	} catch {
		await fs.writeFile(ENV_FILE, '');
	}

	// Initialize settings if they don't exist
	try {
		await fs.access(REGISTRY_SETTINGS_FILE);
	} catch {
		await saveRegistrySettings({
			defaultRegistry: 'elizaos/registry',
		});
	}
}

export async function validateDataDir(): Promise<boolean> {
	const status = await checkDataDir();

	if (!status.exists) {
		logger.warn('ElizaOS data directory not found. Initializing...');
		await initializeDataDir();
		return false;
	}

	let isValid = true;

	if (!status.env.exists) {
		logger.warn('.env file not found');
		isValid = false;
	} else if (!status.env.hasAllKeys) {
		logger.warn(`Missing environment variables: ${status.env.missingKeys.join(', ')}`);
		isValid = false;
	}

	if (!status.settings.exists) {
		logger.warn('Registry settings file not found');
		isValid = false;
	} else if (!status.settings.hasAllKeys) {
		logger.warn(`Missing settings: ${status.settings.missingKeys.join(', ')}`);
		isValid = false;
	}

	return isValid;
}

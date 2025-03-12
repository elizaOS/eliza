#!/usr/bin/env node

/**
 * This script copies the built CLI files into the create-eliza package
 * It should be run as part of the CLI build process
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "fs-extra";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Define paths
const ROOT_DIR = path.resolve(__dirname, "../../../..");
const CLI_DIST_DIR = path.resolve(ROOT_DIR, "packages/cli/dist");

async function main() {
	try {
		// Ensure the CLI is built
		console.log("Checking if CLI is built...");
		if (!fs.existsSync(CLI_DIST_DIR)) {
			console.error("CLI build not found! Build the CLI first.");
			process.exit(1);
		}

		// if templates directory doesn't exist, create it
		const TEMPLATES_DIR = path.resolve(ROOT_DIR, "packages/cli/templates");
		if (!fs.existsSync(TEMPLATES_DIR)) {
			await fs.ensureDir(TEMPLATES_DIR);
		} else {
			// Clean existing templates to prevent conflicts
			await fs.emptyDir(TEMPLATES_DIR);
		}

		// Define source and destination paths with absolute paths
		const projectStarterSrc = path.resolve(ROOT_DIR, "packages/project-starter");
		const projectStarterDest = path.resolve(TEMPLATES_DIR, "project-starter");
		
		const pluginStarterSrc = path.resolve(ROOT_DIR, "packages/plugin-starter");
		const pluginStarterDest = path.resolve(TEMPLATES_DIR, "plugin-starter");

		// Copy project-starter and plugin-starter from packages to packages/cli/templates
		console.log(`Copying from ${projectStarterSrc} to ${projectStarterDest}`);
		await fs.copy(projectStarterSrc, projectStarterDest);
		
		console.log(`Copying from ${pluginStarterSrc} to ${pluginStarterDest}`);
		await fs.copy(pluginStarterSrc, pluginStarterDest);

		// get the version of our CLI, from the package.json
		const CLI_PACKAGE_JSON = path.resolve(ROOT_DIR, "packages/cli/package.json");
		const CLI_PACKAGE_JSON_CONTENT = await fs.readFile(CLI_PACKAGE_JSON, "utf-8");
		const CLI_PACKAGE_JSON_DATA = JSON.parse(CLI_PACKAGE_JSON_CONTENT);
		const CLI_VERSION = CLI_PACKAGE_JSON_DATA.version;

		console.log("CLI version:", CLI_VERSION);
		
		const replacedStarter = await fs.readFile(path.resolve(projectStarterDest, "package.json"), "utf-8");
		const replacedStarterData = JSON.parse(replacedStarter);
		replacedStarterData.version = CLI_VERSION;
		await fs.writeFile(path.resolve(projectStarterDest, "package.json"), JSON.stringify(replacedStarterData, null, 2));

		const replacedPlugin = await fs.readFile(path.resolve(pluginStarterDest, "package.json"), "utf-8");
		const replacedPluginData = JSON.parse(replacedPlugin);
		replacedPluginData.version = CLI_VERSION;
		await fs.writeFile(path.resolve(pluginStarterDest, "package.json"), JSON.stringify(replacedPluginData, null, 2));

		console.log("Templates successfully copied to packages/cli/templates.");
	} catch (error) {
		console.error("Error copying templates:", error);	
		process.exit(1);
	}
}

main();

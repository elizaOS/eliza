import { promises as fs } from "node:fs";
import path from "node:path";
import { logger } from "@/src/utils/logger";
import { getBestBranch } from "@/src/utils/registry";
import { runBunCommand } from "@/src/utils/run-bun";
import { execa } from "execa";

/**
 * Asynchronously installs a plugin to a specified directory.
 *
 * @param {string} pluginName - The name of the plugin to install.
 * @param {string} cwd - The current working directory where the plugin will be installed.
 * @returns {Promise<void>} - A Promise that resolves once the plugin is successfully installed.
 */
export async function installPlugin(
	pluginName: string,
	cwd: string,
): Promise<void> {
	// Remove 'github:' or leading '@' prefix if present
	const cleanedName = pluginName.replace(/^github:|^@/, "");
	let installed = false;
	try {
		//logger.info(`Attempting to install ${pluginName} using bun add...`);
		//await runBunCommand(["add", `${pluginName}`], cwd);
		//logger.success(`Successfully installed ${pluginName} via bun add.`);
		//installed = true;
		// Set the directory to clone into the packages folder (each plugin gets its own subfolder)
		const cloneDir = path.join(
			cwd,
			"packages",
			cleanedName.replace(/\S+\//, ""),
		);

		// Get repository URL
		const repoUrl = `https://github.com/${cleanedName}.git`;

		// Determine the best branch to use
		const branch = await getBestBranch(repoUrl);

		// Clone with the specific branch if not main
		if (branch === "main") {
			logger.info(`Cloning ${pluginName} from ${repoUrl} to ${cloneDir}`);
			await execa("git", ["clone", repoUrl, cloneDir], {
				cwd,
				stdio: "inherit",
			});
		} else {
			logger.info(
				`Cloning ${pluginName} from ${repoUrl} (branch: ${branch}) to ${cloneDir}`,
			);
			await execa("git", ["clone", "-b", branch, repoUrl, cloneDir], {
				cwd,
				stdio: "inherit",
			});
		}

		logger.success(
			`Successfully cloned repository for ${cleanedName} (${branch} branch).`,
		);
		installed = true;
	} catch (error: any) {
		logger.warn(
			`failed to install packages for ${cleanedName}, falling back: ${error.message}`,
		);
	}

	if (installed) {
		// Try to read the package.json file from the cloned plugin repo
		let pkgName = cleanedName;
		const pkgPath = path.join(
			cwd,
			"packages",
			cleanedName.replace(/\S+\//, ""),
			"package.json",
		);
		try {
			const pkgContent = await fs.readFile(pkgPath, "utf-8");
			const pkg = JSON.parse(pkgContent);
			if (pkg.name) {
				pkgName = pkg.name;
				logger.info(`Found package.json name: ${pkgName}`);
				logger.info(
					`Add ${pkgName} to your character's plugins config (packages/agent/defaultCharacter.ts)`,
				);
			}
		} catch (err: any) {
			logger.warn(
				`Could not read package.json from ${pkgPath}: ${err.message}`,
			);
		}
	}
}

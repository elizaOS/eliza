import { logger } from '@elizaos/core';
import { execa } from 'execa';
import { getPluginVersion } from './registry';

/**
 * Asynchronously installs a plugin to a specified directory.
 *
 * @param {string} repository - The repository URL of the plugin to install.
 * @param {string} cwd - The current working directory where the plugin will be installed.
 * @param {string} version - The specific version of the plugin to install.
 * @returns {Promise<boolean>} - A Promise that resolves to true if the plugin is successfully installed, or false otherwise.
 */
export async function installPlugin(
	repository: string,
	cwd: string,
	version?: string,
): Promise<boolean> {
	// Mark this plugin as installed to ensure we don't get into an infinite loop
	logger.info(`Installing plugin: ${repository}`);

	if(version) {
		try {
			await execa('bun', ['add', `${repository}@${version}`], {
				cwd,
				stdio: 'inherit',
			});
			return true;
		} catch (error) {
			logger.debug('Plugin not found on npm, trying to install from registry...');
		}
	}
	try {
		// Clean repository URL
		let repoUrl = repository;
		if (repoUrl.startsWith('git+')) {
			repoUrl = repoUrl.substring(4);
		}
		if (repoUrl.endsWith('.git')) {
			repoUrl = repoUrl.slice(0, -4);
		}

		// Get specific version if requested
		let installVersion = '';
		if (version) {
			const resolvedVersion = await getPluginVersion(repoUrl, version);
			if (!resolvedVersion) {
				logger.error(`Version ${version} not found for plugin ${repoUrl}`);
				return false;
			}
			installVersion = `#${resolvedVersion}`;
		}

		// Install using bun
		await execa('bun', ['add', `${repoUrl}${installVersion}`], {
			cwd,
			stdio: 'inherit',
		});

		return true;
	} catch (error) {
		logger.error('Failed to install plugin:', error);
		return false;
	}
}

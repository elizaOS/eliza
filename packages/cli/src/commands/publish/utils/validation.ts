import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as clack from '@clack/prompts';
import { PackageJson } from '../types';

/**
 * Validate plugin requirements
 */
export async function validatePluginRequirements(
  cwd: string,
  packageJson: PackageJson
): Promise<void> {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check plugin naming convention (this is still a hard error)
  const packageName = packageJson.name.split('/').pop() || packageJson.name;
  if (!packageName.startsWith('plugin-')) {
    errors.push(
      'Plugin name must start with "plugin-". Please update your package name and try again.'
    );
  }

  // Check if description is still the default generated one (warning)
  const pluginDirName = path.basename(cwd);
  const expectedDefaultDesc = `ElizaOS plugin for ${pluginDirName.replace('plugin-', '')}`;
  if (
    packageJson.description === expectedDefaultDesc ||
    packageJson.description === '${PLUGINDESCRIPTION}'
  ) {
    warnings.push(
      'Description appears to be the default generated description. Consider writing a custom description.'
    );
  }

  // Check for required images (warnings)
  const imagesDir = path.join(cwd, 'images');
  const logoPath = path.join(imagesDir, 'logo.jpg');
  const bannerPath = path.join(imagesDir, 'banner.jpg');

  try {
    await fs.access(logoPath);
  } catch {
    warnings.push('Missing required logo.jpg in images/ directory (400x400px, max 500KB).');
  }

  try {
    await fs.access(bannerPath);
  } catch {
    warnings.push('Missing required banner.jpg in images/ directory (1280x640px, max 1MB).');
  }

  // Handle hard errors (must be fixed)
  if (errors.length > 0) {
    console.error('Plugin validation failed:');
    errors.forEach((error) => console.error(`  - ${error}`));
    console.error('\nPlease fix these issues and try publishing again.');
    process.exit(1);
  }

  // Handle warnings (can be bypassed)
  if (warnings.length > 0) {
    console.warn('Plugin validation warnings:');
    warnings.forEach((warning) => console.warn(`  - ${warning}`));
    console.warn('Your plugin may get rejected if you submit without addressing these issues.');

    const proceed = await clack.confirm({
      message: 'Do you wish to continue anyway?',
      initialValue: false,
    });

    if (clack.isCancel(proceed)) {
      clack.cancel('Operation cancelled.');
      process.exit(0);
    }

    if (!proceed) {
      console.info('Publishing cancelled. Please address the warnings and try again.');
      process.exit(0);
    }
  }
}

/**
 * Check if user is a maintainer for the package
 */
export function isMaintainer(packageJson: PackageJson, username: string): boolean {
  if (!packageJson.maintainers) {
    // If no maintainers specified, the publisher becomes the first maintainer
    return true;
  }

  return packageJson.maintainers.includes(username);
}

/**
 * Display appropriate registry publication messaging based on options and user status
 */
export function displayRegistryPublicationMessage(
  opts: { skipRegistry?: boolean; npm?: boolean },
  userIsMaintainer: boolean,
  registryPrUrl?: string
): void {
  // Early returns for clear flow control
  if (opts.skipRegistry) {
    console.info('Registry publication skipped as requested with --skip-registry flag');
    return;
  }

  if (opts.npm) {
    // NPM-only publishing with registry enabled
    console.warn('NPM publishing currently does not update the registry.');
    console.info('To include this package in the registry:');
    console.info(`1. Fork the registry repository at https://github.com/elizaos/registry`);
    console.info('2. Add your package metadata');
    console.info('3. Submit a pull request to the main repository');
    return;
  }

  // GitHub + registry publishing
  if (userIsMaintainer) {
    // For GitHub publishing, PR is already created by publishToGitHub
    if (!registryPrUrl) {
      console.info('Registry publication completed during GitHub publishing process.');
    }
  } else {
    // For non-maintainers, show instructions for registry inclusion
    console.info("Package published, but you're not a maintainer of this package.");
    console.info('To include this package in the registry, please:');
    console.info(`1. Fork the registry repository at https://github.com/elizaos/registry`);
    console.info('2. Add your package metadata');
    console.info('3. Submit a pull request to the main repository');
  }
}

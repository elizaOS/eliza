import { bunExecInherit } from '../../../utils/bun-exec.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PackageJson } from '../types';

/**
 * Build and publish package to npm
 */
export async function publishToNpm(
  cwd: string,
  packageJson: PackageJson,
  npmUsername: string
): Promise<void> {
  console.info(`Publishing as npm user: ${npmUsername}`);

  // Update npmPackage field if it's a placeholder or not set
  if (!packageJson.npmPackage || packageJson.npmPackage === '${NPM_PACKAGE}') {
    // Validate inputs before creating scoped name
    if (!packageJson.name || packageJson.name.trim() === '') {
      throw new Error('Invalid package.json: name field is required for scoping');
    }

    if (packageJson.name.startsWith('@')) {
      throw new Error(
        'Package name is already scoped - this should not happen with current templates'
      );
    }

    if (!npmUsername || npmUsername.trim() === '') {
      throw new Error('npm username is required for package scoping');
    }

    // Strip any existing scope from packageJson.name
    const unscopedName = packageJson.name.startsWith('@')
      ? packageJson.name.split('/').slice(1).join('/')
      : packageJson.name;
    packageJson.npmPackage = `@${npmUsername}/${unscopedName}`;
    console.info(`Set npmPackage to: ${packageJson.npmPackage}`);

    // Save updated package.json
    const packageJsonPath = path.join(cwd, 'package.json');
    await fs.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2), 'utf-8');
  }

  // Build the package
  console.info('Building package...');
  await bunExecInherit('npm', ['run', 'build'], { cwd });

  // Publish to npm with --ignore-scripts to prevent recursion
  console.info('Publishing to npm...');
  await bunExecInherit('npm', ['publish', '--ignore-scripts'], { cwd });

  console.log(`[√] Successfully published ${packageJson.name}@${packageJson.version} to npm`);
}

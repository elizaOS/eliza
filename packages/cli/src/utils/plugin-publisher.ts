import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import { logger } from '@elizaos/core';
import {
  branchExists,
  createBranch,
  createPullRequest,
  forkExists,
  forkRepository,
  getFileContent,
  updateFile,
} from './github';
import { getRegistrySettings, getGitHubToken } from './registry';

interface PackageJson {
  name: string;
  version: string;
  description?: string;
  author?: string;
  repository?: {
    url?: string;
  };
}

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

interface PublishTestResult {
  npmChecks: {
    loggedIn: boolean;
    canBuild: boolean;
    hasPermissions: boolean;
  };
  githubChecks: {
    hasToken: boolean;
    hasValidToken: boolean;
    hasForkAccess: boolean;
    canCreateBranch: boolean;
    canUpdateFiles: boolean;
    canCreatePR: boolean;
  };
  packageChecks: {
    hasPackageJson: boolean;
    hasValidName: boolean;
    hasVersion: boolean;
    hasRepository: boolean;
    versionNotExists: boolean;
  };
}

export async function testPublishToNpm(cwd: string): Promise<boolean> {
  try {
    // Check if logged in to npm
    await execa('npm', ['whoami']);
    logger.info('✓ Logged in to npm');

    // Test build
    logger.info('Testing build...');
    await execa('npm', ['run', 'build', '--dry-run'], { cwd });
    logger.info('✓ Build test successful');

    // Test publish access
    const pkgJson = JSON.parse(await fs.readFile(path.join(cwd, 'package.json'), 'utf-8'));
    await execa('npm', ['access', 'ls-packages'], { cwd });
    logger.info('✓ Have publish permissions');

    return true;
  } catch (error) {
    logger.error('Test failed:', error);
    return false;
  }
}

export async function testPublishToGitHub(
  cwd: string,
  packageJson: PackageJson,
  username: string,
): Promise<boolean> {
  try {
    // Check GitHub token
    const token = await getGitHubToken();
    if (!token) {
      logger.error('GitHub token not found');
      return false;
    }
    logger.info('✓ GitHub token found');

    // Validate token permissions
    const response = await fetch('https://api.github.com/user', {
      headers: { Authorization: `token ${token}` },
    });
    if (!response.ok) {
      logger.error('Invalid GitHub token or insufficient permissions');
      return false;
    }
    logger.info('✓ GitHub token is valid');

    // Test registry access
    const settings = await getRegistrySettings();
    const [registryOwner, registryRepo] = settings.defaultRegistry.split('/');

    // Check fork permissions
    const hasFork = await forkExists(token, registryOwner, registryRepo, username);
    logger.info(hasFork ? '✓ Fork exists' : '✓ Can create fork');

    // Test branch creation
    const branchName = `test-${packageJson.name.replace(/^@elizaos\//, '')}-${packageJson.version}`;
    const hasBranch = await branchExists(token, username, registryRepo, branchName);
    logger.info(hasBranch ? '✓ Test branch exists' : '✓ Can create branch');

    // Test file update permissions
    const testPath = `test/${packageJson.name.replace(/^@elizaos\//, '')}.json`;
    const canUpdate = await updateFile(
      token,
      username,
      registryRepo,
      testPath,
      JSON.stringify({ test: true }),
      'Test file update',
      'main',
    );
    if (!canUpdate) {
      logger.error('Cannot update files in repository');
      return false;
    }
    logger.info('✓ Can update files');

    return true;
  } catch (error) {
    logger.error('Test failed:', error);
    return false;
  }
}

export async function publishToNpm(cwd: string): Promise<boolean> {
  try {
    // Check if logged in to npm
    await execa('npm', ['whoami']);

    // Build the package
    logger.info('Building package...');
    await execa('npm', ['run', 'build'], { cwd, stdio: 'inherit' });

    // Publish to npm
    logger.info('Publishing to npm...');
    await execa('npm', ['publish'], { cwd, stdio: 'inherit' });

    return true;
  } catch (error) {
    logger.error('Failed to publish to npm:', error);
    return false;
  }
}

export async function publishToGitHub(
  cwd: string,
  packageJson: PackageJson,
  cliVersion: string,
  username: string,
  isTest = false,
): Promise<boolean> {
  const token = await getGitHubToken();
  if (!token) {
    logger.error('GitHub token not found. Please set it using the login command.');
    return false;
  }

  if (isTest) {
    logger.info('Running in test mode - no actual changes will be made');
  }

  const settings = await getRegistrySettings();
  const [registryOwner, registryRepo] = settings.defaultRegistry.split('/');

  // Check for fork
  const hasFork = await forkExists(token, registryOwner, registryRepo, username);
  let forkFullName: string;

  if (!hasFork && !isTest) {
    logger.info(`Creating fork of ${settings.defaultRegistry}...`);
    const fork = await forkRepository(token, registryOwner, registryRepo);
    if (!fork) {
      logger.error('Failed to fork registry repository.');
      return false;
    }
    forkFullName = fork;
  } else {
    forkFullName = `${username}/${registryRepo}`;
    logger.info(`Using existing fork: ${forkFullName}`);
  }

  // Create version branch
  const branchName = `plugin-${packageJson.name.replace(/^@elizaos\//, '')}-${packageJson.version}`;
  const hasBranch = await branchExists(token, username, registryRepo, branchName);

  if (!hasBranch && !isTest) {
    logger.info(`Creating branch ${branchName}...`);
    const created = await createBranch(token, username, registryRepo, branchName);
    if (!created) {
      logger.error('Failed to create branch.');
      return false;
    }
  }

  // Update package metadata
  const packagePath = `packages/${packageJson.name.replace(/^@elizaos\//, '')}.json`;
  const existingContent = await getFileContent(token, registryOwner, registryRepo, packagePath);

  let metadata: PluginMetadata;
  if (existingContent) {
    metadata = JSON.parse(existingContent);
    
    if (metadata.versions.includes(packageJson.version)) {
      logger.error(`Version ${packageJson.version} already exists in registry.`);
      return false;
    }

    metadata.versions.push(packageJson.version);
    metadata.latestVersion = packageJson.version;
    metadata.runtimeVersion = cliVersion;
  } else {
    metadata = {
      name: packageJson.name,
      description: packageJson.description || '',
      author: packageJson.author || '',
      repository: packageJson.repository?.url || '',
      versions: [packageJson.version],
      latestVersion: packageJson.version,
      runtimeVersion: cliVersion,
      maintainer: username,
      tags: [],
      categories: [],
    };
  }

  if (!isTest) {
    // Update package file
    const updated = await updateFile(
      token,
      username,
      registryRepo,
      packagePath,
      JSON.stringify(metadata, null, 2),
      `Update ${packageJson.name} to version ${packageJson.version}`,
      branchName,
    );

    if (!updated) {
      logger.error('Failed to update package metadata.');
      return false;
    }

    // Create pull request
    const prCreated = await createPullRequest(
      token,
      registryOwner,
      registryRepo,
      `Add ${packageJson.name}@${packageJson.version} to registry`,
      `This PR adds ${packageJson.name} version ${packageJson.version} to the registry.

- Package name: ${packageJson.name}
- Version: ${packageJson.version}
- Runtime version: ${cliVersion}
- Description: ${packageJson.description || 'No description provided'}
- Repository: ${metadata.repository}

Submitted by: @${username}`,
      `${username}:${branchName}`,
      'main',
    );

    if (!prCreated) {
      logger.error('Failed to create pull request.');
      return false;
    }

    logger.success(`Pull request created: ${prCreated}`);
  } else {
    logger.info('Test successful - all checks passed');
    logger.info('Would create:');
    logger.info(`- Branch: ${branchName}`);
    logger.info(`- Package file: ${packagePath}`);
    logger.info(`- Pull request: Add ${packageJson.name}@${packageJson.version} to registry`);
  }

  return true;
} 
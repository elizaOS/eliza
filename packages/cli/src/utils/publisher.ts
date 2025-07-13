import { bunExec, bunExecInherit } from '@/src/utils/bun-exec';
import { logger } from '@elizaos/core';
import {
  branchExists,
  createBranch,
  createPullRequest,
  forkExists,
  forkRepository,
  getFileContent,
  getGitHubCredentials,
  updateFile,
  ensureDirectory,
  createGitHubRepository,
  pushToGitHub,
} from './github';
import { getRegistrySettings } from './registry';

interface PackageJson {
  name: string;
  version: string;
  description?: string;
  author?: string;
  repository?: {
    url?: string;
  };
  keywords?: string[];
  categories?: string[];
  platform?: 'node' | 'browser' | 'universal';
  packageType?: 'plugin' | 'project';
  type?: string; // 'module' or 'commonjs' for Node.js module format
}

/**
 * Tests whether the current environment is ready to publish an npm package from the specified directory.
 *
 * Performs checks for npm login status, build success, and publish permissions in the given directory.
 *
 * @param cwd - The directory containing the npm package to test.
 * @returns `true` if all checks pass; otherwise, `false`.
 */
export async function testPublishToNpm(cwd: string): Promise<boolean> {
  try {
    // Check if logged in to npm
    await bunExec('npm', ['whoami']);
    logger.info('[✓] Logged in to npm');

    // Test build
    logger.info('Testing build...');
    await bunExec('npm', ['run', 'build', '--dry-run'], { cwd });
    logger.info('[✓] Build test successful');

    // Test publish access
    await bunExec('npm', ['access', 'ls-packages'], { cwd });
    logger.info('[✓] Have publish permissions');

    return true;
  } catch (error) {
    logger.error('Test failed:', error);
    if (error instanceof Error) {
      logger.error(`Error message: ${error.message}`);
      logger.error(`Error stack: ${error.stack}`);
    }
    return false;
  }
}

/**
 * Tests whether the current user has the necessary GitHub credentials and permissions to publish a package and update the registry.
 *
 * For projects, verifies that a valid GitHub token is available. For plugins, additionally checks the ability to fork the registry repository, create a branch, and update files within that branch.
 *
 * @param cwd - The working directory of the package.
 * @param packageJson - The parsed package.json metadata for the package.
 * @param username - The GitHub username to use for repository operations.
 * @returns `true` if all required GitHub permissions and operations succeed; otherwise, `false`.
 */
export async function testPublishToGitHub(
  packageJson: PackageJson,
  username: string
): Promise<boolean> {
  try {
    // Get GitHub credentials using getGitHubCredentials which will prompt if needed
    const credentials = await getGitHubCredentials();
    if (!credentials) {
      logger.error('Failed to get GitHub credentials');
      return false;
    }
    const token = credentials.token;
    logger.info('[✓] GitHub credentials found');

    // Validate token permissions
    const response = await fetch('https://api.github.com/user', {
      headers: { Authorization: `token ${token}` },
    });
    if (!response.ok) {
      logger.error('Invalid GitHub token or insufficient permissions');
      return false;
    }
    logger.info('[✓] GitHub token is valid');

    // For projects, we only need to check GitHub token validity
    if (packageJson.packageType === 'project') {
      logger.info('[✓] Project validation complete - GitHub token is valid');
      return true;
    }

    // The following tests are only for plugins that need registry updates

    // Test registry access
    const settings = await getRegistrySettings();
    const [registryOwner, registryRepo] = settings.defaultRegistry.split('/');

    // Log the registry we're testing with
    logger.info(`Testing with registry: ${registryOwner}/${registryRepo}`);

    // Check fork permissions and create fork if needed
    const hasFork = await forkExists(token, registryRepo, username);
    logger.info(hasFork ? '[✓] Fork exists' : '[✓] Can create fork');

    if (!hasFork) {
      logger.info('Creating fork...');
      const forkCreated = await forkRepository(token, registryOwner, registryRepo);
      if (!forkCreated) {
        logger.error('Failed to create fork');
        return false;
      }
      logger.info('[✓] Fork created');

      // Wait a moment for GitHub to complete the fork
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }

    // Test branch creation
    const branchName = `test-${packageJson.name.replace(/^@[^/]+\//, '')}-${packageJson.version}`;
    const hasBranch = await branchExists(token, username, registryRepo, branchName);
    logger.info(hasBranch ? '[✓] Test branch exists' : '[✓] Can create branch');

    if (!hasBranch) {
      logger.info('Creating branch...');
      const branchCreated = await createBranch(token, username, registryRepo, branchName, 'main');
      if (!branchCreated) {
        logger.error('Failed to create branch');
        return false;
      }
      logger.info('[✓] Branch created');
    }

    // Test file update permissions - try a test file in the test directory
    const simpleName = packageJson.name.replace(/^@[^/]+\//, '').replace(/[^a-zA-Z0-9-]/g, '-');
    // Change the path to try "test-files" directory rather than root
    const testPath = `test-files/${simpleName}-test.json`;
    logger.info(`Attempting to create test file: ${testPath} in branch: ${branchName}`);

    // Try to create the directory first if needed
    const dirCreated = await ensureDirectory(
      token,
      `${username}/${registryRepo}`,
      'test-files',
      branchName
    );
    if (!dirCreated) {
      logger.warn('Failed to create test directory, but continuing with file creation');
    }

    const canUpdate = await updateFile(
      token,
      username,
      registryRepo,
      testPath,
      JSON.stringify({ test: true, timestamp: new Date().toISOString() }),
      'Test file update',
      branchName // Use the test branch instead of main
    );
    if (!canUpdate) {
      logger.error('Cannot update files in repository');
      return false;
    }
    logger.info('[✓] Can create and update files');

    return true;
  } catch (error) {
    logger.error('Test failed:', error);
    return false;
  }
}

export async function publishToNpm(cwd: string): Promise<boolean> {
  try {
    // Check if logged in to npm
    await bunExec('npm', ['whoami']);

    // Build the package
    logger.info('Building package...');
    await bunExecInherit('npm', ['run', 'build'], { cwd });

    // Publish to npm
    logger.info('Publishing to npm...');
    await bunExecInherit('npm', ['publish'], { cwd });

    return true;
  } catch (error) {
    logger.error('Failed to publish to npm:', error);
    return false;
  }
}

/**
 * Publishes a package to GitHub and optionally updates the ElizaOS registry for plugins.
 *
 * For both plugins and projects, this function creates or verifies a GitHub repository, pushes the local code, and returns success. For plugins (unless {@link skipRegistry} is true), it also updates the ElizaOS registry by forking the registry repository, creating a branch, updating or creating the package metadata, updating the registry index, and opening a pull request.
 *
 * @param cwd - The working directory containing the package to publish.
 * @param packageJson - The parsed package.json object for the package.
 * @param username - The GitHub username of the publisher.
 * @param skipRegistry - If true, skips registry updates and only publishes to GitHub.
 * @param isTest - If true, runs in test mode without making actual changes.
 * @returns True on success, or an object with success status and pull request URL if a registry PR is created; false on failure.
 *
 * @throws {Error} If required fields are missing or if publishing steps fail.
 *
 * @remark
 * - For projects or when {@link skipRegistry} is true, registry updates are skipped and only the GitHub repository is updated.
 * - For plugins, registry updates include metadata and index updates, and a pull request to the registry repository.
 */
export async function publishToGitHub(
  cwd: string,
  packageJson: PackageJson,
  username: string,
  skipRegistry = false,
  isTest = false
): Promise<boolean | { success: boolean; prUrl?: string }> {
  // Get GitHub credentials using getGitHubCredentials which will prompt if needed
  const credentials = await getGitHubCredentials();
  if (!credentials) {
    logger.error('Failed to get GitHub credentials');
    return false;
  }
  const token = credentials.token;

  // Validate required package type
  if (!packageJson.packageType) {
    logger.error(
      'Package type is required. Set "packageType" to either "plugin" or "project" in package.json'
    );
    return false;
  }

  // Validate that packageType is either plugin or project
  if (packageJson.packageType !== 'plugin' && packageJson.packageType !== 'project') {
    logger.error(
      `Invalid package type: ${packageJson.packageType}. Must be either "plugin" or "project"`
    );
    return false;
  }

  if (isTest) {
    logger.info('Running in test mode - no actual changes will be made');
  }

  if (skipRegistry) {
    logger.info('Registry updates will be skipped as requested with --skip-registry flag');
  }

  // First, create the repository and push code to GitHub
  if (!isTest) {
    const repoName = packageJson.name.replace(/^@[^/]+\//, '');
    const description = packageJson.description || `ElizaOS ${packageJson.packageType}`;

    // Set the appropriate topic based on package type - only one topic, no mixing
    let topic;
    if (packageJson.packageType === 'plugin') {
      topic = 'elizaos-plugins';
    } else if (packageJson.packageType === 'project') {
      topic = 'elizaos-projects';
    } else {
      topic = 'elizaos-plugins'; // Default to plugins if type is unknown
    }

    // Create GitHub repository with only the single appropriate topic
    logger.info(`Checking/creating GitHub repository: ${username}/${repoName}`);
    const repoResult = await createGitHubRepository(token, repoName, description, false, [topic]);

    if (!repoResult.success) {
      logger.error(`Failed to create GitHub repository: ${repoResult.message}`);
      return false;
    }

    // Repository exists or was created successfully
    logger.info(`Using repository: ${repoResult.repoUrl}`);

    // Construct repository URL with token for git operations
    const repoUrl = `https://${token}@github.com/${username}/${repoName}.git`;

    // Push code to GitHub
    logger.info('Pushing code to GitHub...');
    const pushSuccess = await pushToGitHub(cwd, repoUrl);
    if (!pushSuccess) {
      logger.error('Failed to push code to GitHub repository.');
      return false;
    }
    logger.success('Successfully pushed code to GitHub repository');

    // For projects or when skipRegistry is true, we're done - skip registry update
    if (packageJson.packageType === 'project' || skipRegistry) {
      const reason =
        packageJson.packageType === 'project'
          ? 'Projects do not need registry updates'
          : 'Registry updates skipped as requested with --skip-registry flag';
      logger.info(`${packageJson.name} published to GitHub successfully. ${reason}`);
      return {
        success: true,
        prUrl: repoResult.repoUrl,
      };
    }
  }

  // The following code is for plugin registry updates only
  // Skip if we're publishing a project or skipRegistry is true
  if (packageJson.packageType === 'project' || skipRegistry) {
    if (isTest) {
      logger.info('Test successful - project would be published to GitHub only');
    }
    return true;
  }

  const settings = await getRegistrySettings();
  const [registryOwner, registryRepo] = settings.defaultRegistry.split('/');

  // Check for fork
  const hasFork = await forkExists(token, registryRepo, username);
  let forkFullName: string;

  if (!hasFork && !isTest) {
    logger.info(`Creating fork of ${settings.defaultRegistry}...`);
    const fork = await forkRepository(token, registryOwner, registryRepo);
    if (!fork) {
      logger.error('Failed to fork registry repository.');
      return false;
    }
    forkFullName = fork;

    // Small delay just in case
    await new Promise((resolve) => setTimeout(resolve, 2000));
  } else {
    forkFullName = `${username}/${registryRepo}`;
    logger.info(`Using existing fork: ${forkFullName}`);
  }

  // Create version branch - use the package type without default
  const entityType = packageJson.packageType;
  const packageNameWithoutScope = packageJson.name.replace(/^@[^/]+\//, '');

  // Fix branch naming to avoid double "plugin-" prefix
  let branchName: string;
  if (entityType === 'plugin' && packageNameWithoutScope.startsWith('plugin-')) {
    // For plugin names starting with 'plugin-', use only one 'plugin-' prefix
    // Example: plugin-apple -> plugin-apple-0.1.0 (not plugin-plugin-apple-0.1.0)
    branchName = `${packageNameWithoutScope}-${packageJson.version}`;
    logger.info(`Using package name directly to avoid duplicate plugin prefix: ${branchName}`);
  } else {
    // For other package types or non-plugin-prefixed names, use entityType prefix
    branchName = `${entityType}-${packageNameWithoutScope}-${packageJson.version}`;
  }

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
  const packageName = packageJson.name.replace(/^@[^/]+\//, '');

  // Use the actual npm package name from package.json (not @elizaos/ prefix)
  const registryPackageName = packageJson.name;

  if (!isTest) {
    // Update index.json with simple mapping: npm package name -> github repo
    try {
      const indexContent = await getFileContent(token, username, registryRepo, 'index.json');
      if (indexContent) {
        // Simple mapping: npm package name -> github repo
        const githubRepo = `github:${username}/${packageName}`;

        // Check if entry already exists by parsing the JSON
        const index = JSON.parse(indexContent);
        if (index[registryPackageName]) {
          logger.warn(`Package ${registryPackageName} already exists in registry`);
          return false;
        }

        logger.info(`Adding registry entry: ${registryPackageName} -> ${githubRepo}`);

        // Find the correct alphabetical position to insert the new entry
        const lines = indexContent.split('\n');
        const newEntry = `    "${registryPackageName}": "${githubRepo}",`;

        // Find the correct insertion point alphabetically
        let insertIndex = -1;
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();

          // Skip empty lines and opening brace
          if (!line || line === '{') continue;

          // If we hit the closing brace, insert before it
          if (line === '}') {
            insertIndex = i;
            break;
          }

          // Check if this is a package entry line
          const match = line.match(/^\s*"(@[^"]+)"/);
          if (match) {
            const existingPackage = match[1];
            // If our package should come before this one alphabetically
            if (registryPackageName < existingPackage) {
              insertIndex = i;
              break;
            }
          }
        }

        // If we didn't find a position, insert before the closing brace
        if (insertIndex === -1) {
          for (let i = lines.length - 1; i >= 0; i--) {
            if (lines[i].trim() === '}') {
              insertIndex = i;
              break;
            }
          }
        }

        if (insertIndex === -1) {
          logger.error('Could not find insertion point in index.json');
          return false;
        }

        // Insert the new entry at the correct alphabetical position
        lines.splice(insertIndex, 0, newEntry);
        const updatedContent = lines.join('\n');

        // Update index.json with minimal change - preserve original structure
        const indexUpdated = await updateFile(
          token,
          username,
          registryRepo,
          'index.json',
          updatedContent,
          `Add ${registryPackageName} to registry`,
          branchName
        );

        if (!indexUpdated) {
          logger.error('Failed to update registry index.');
          return false;
        }
      } else {
        logger.error('Could not fetch index.json from registry');
        return false;
      }
    } catch (error) {
      logger.error(
        `Failed to update index.json: ${error instanceof Error ? error.message : String(error)}`
      );
      return false;
    }

    // Create pull request
    const prUrl = await createPullRequest(
      token,
      registryOwner,
      registryRepo,
      `Add ${registryPackageName} to registry`,
      `This PR adds ${registryPackageName} to the registry.

- Package name: ${registryPackageName}
- GitHub repository: github:${username}/${packageName}
- Version: ${packageJson.version}
- Description: ${packageJson.description || 'No description provided'}

Submitted by: @${username}`,
      `${username}:${branchName}`,
      'main'
    );

    if (!prUrl) {
      logger.error('Failed to create pull request.');
      return false;
    }

    logger.success(`Pull request created: ${prUrl}`);

    // Return success with PR URL
    return {
      success: true,
      prUrl: prUrl,
    };
  } else {
    logger.info('Test successful - all checks passed');
    logger.info('Would create:');
    logger.info(`- Branch: ${branchName}`);
    logger.info(`- Registry entry: ${registryPackageName} -> github:${username}/${packageName}`);
    logger.info(`- Pull request: Add ${registryPackageName} to registry`);
  }

  return true;
}

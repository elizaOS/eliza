import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getGitHubCredentials, createGitHubRepository, pushToGitHub } from '@/src/utils/github';
import { handleError } from '@/src/utils/handle-error';
import {
  publishToGitHub,
  testPublishToGitHub,
  testPublishToNpm,
} from '@/src/utils/plugin-publisher';
import {
  getRegistrySettings,
  initializeDataDir,
  saveRegistrySettings,
  validateDataDir,
} from '@/src/utils/registry/index';
import { logger } from '@elizaos/core';
import { Command } from 'commander';
import { execa } from 'execa';
import prompts from 'prompts';
import readline from 'node:readline';

export const plugin = new Command()
  .name('plugin')
  .description('Manage ElizaOS plugins, including publishing');

/**
 * Note: The plugin creation functionality is now in the main create.ts file.
 * Use "npx @elizaos/cli create" and select "plugin" when prompted.
 */

/**
 * Check if a plugin meets all registry requirements
 */
async function checkRegistryRequirements(cwd: string) {
  const packageJsonPath = path.join(cwd, 'package.json');
  if (!existsSync(packageJsonPath)) {
    return {
      name: false,
      imagesDir: false,
      logoImage: false,
      bannerImage: false,
      agentConfig: false,
      repository: false,
      repoFormat: false,
      description: false,
    };
  }

  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf-8'));

  return {
    name: packageJson.name.includes('plugin-') || packageJson.name.includes('@elizaos/plugin-'),
    imagesDir: existsSync(path.join(cwd, 'images')),
    logoImage: existsSync(path.join(cwd, 'images', 'logo.jpg')),
    bannerImage: existsSync(path.join(cwd, 'images', 'banner.jpg')),
    agentConfig:
      !!packageJson.agentConfig &&
      !!packageJson.agentConfig.pluginType &&
      !!packageJson.agentConfig.pluginParameters,
    repository: !!(packageJson.repository && packageJson.repository.url),
    repoFormat: packageJson.repository?.url
      ? packageJson.repository.url.startsWith('github:') &&
        !packageJson.repository.url.includes('.git')
      : false,
    description: !!packageJson.description,
  };
}

/**
 * Authenticate with GitHub and get a token
 */
async function authenticateWithGitHub(): Promise<{ token: string; username: string }> {
  let token = process.env.GITHUB_TOKEN || null;

  if (!token) {
    console.info('\nGitHub credentials required for publishing.');
    console.info("You'll need a GitHub Personal Access Token with these scopes:");
    console.info('  * repo (for repository access)');
    console.info('  * read:org (for organization access)');
    console.info('  * workflow (for workflow access)\n');

    await initializeDataDir();

    const credentials = await getGitHubCredentials();
    if (!credentials) {
      console.error('GitHub credentials setup cancelled.');
      process.exit(1);
    }

    token = credentials.token;
  }

  try {
    // Test the token by making a request to get the authenticated user
    const response = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `token ${token}`,
      },
    });

    if (!response.ok) {
      console.error('Invalid GitHub token. Please enter a valid token.');
      process.exit(1);
    }

    // Get the username from the response
    const data = await response.json();
    const username = data.login;

    // Set the username in the environment for other parts of the code to use
    process.env.GITHUB_USERNAME = username;

    return { token, username };
  } catch (error) {
    console.error('Error authenticating with GitHub. Please try again later.');
    process.exit(1);
  }
}

plugin
  .command('publish')
  .description('Publish a plugin to a registry')
  .option('-r, --registry <registry>', 'target registry', 'elizaOS/registry')
  .option('-n, --npm', 'publish to npm instead of GitHub', false)
  .option('-t, --test', 'test publish process without making changes', false)
  .option(
    '-px, --platform <platform>',
    'specify platform compatibility (node, browser, universal)',
    'universal'
  )
  .action(async (opts) => {
    try {
      // Authenticate with GitHub first to get the username
      const { token, username } = await authenticateWithGitHub();

      const cwd = process.cwd();

      // Validate data directory and settings
      const isValid = await validateDataDir();
      if (!isValid) {
        console.info('\nGitHub credentials required for publishing.');
        console.info("You'll need a GitHub Personal Access Token with these scopes:");
        console.info('  * repo (for repository access)');
        console.info('  * read:org (for organization access)');
        console.info('  * workflow (for workflow access)\n');

        // Initialize data directory first
        await initializeDataDir();

        // Use the built-in credentials function
        const credentials = await getGitHubCredentials();
        if (!credentials) {
          console.error('GitHub credentials setup cancelled.');
          process.exit(1);
        }

        // Revalidate after saving credentials
        const revalidated = await validateDataDir();
        if (!revalidated) {
          console.error('Failed to validate credentials after saving.');
          process.exit(1);
        }
      }

      // Check if this is a plugin directory
      const packageJsonPath = path.join(cwd, 'package.json');
      if (!existsSync(packageJsonPath)) {
        console.error('No package.json found in current directory.');
        process.exit(1);
      }

      // Read package.json
      const packageJsonContent = await fs.readFile(packageJsonPath, 'utf-8');
      const packageJson = JSON.parse(packageJsonContent);

      if (!packageJson.name || !packageJson.version) {
        console.error('Invalid package.json: missing name or version.');
        process.exit(1);
      }

      // Validate platform option
      const validPlatforms = ['node', 'browser', 'universal'];
      if (opts.platform && !validPlatforms.includes(opts.platform)) {
        console.error(
          `Invalid platform: ${opts.platform}. Valid options are: ${validPlatforms.join(', ')}`
        );
        process.exit(1);
      }

      // Add platform to package.json if specified
      if (opts.platform) {
        packageJson.platform = opts.platform;
      }

      // Validate GitHub credentials
      let credentials = await getGitHubCredentials();
      if (!credentials) {
        console.error('GitHub credentials are required for publishing plugins.');
        return;
      }

      // Check registry requirements
      console.info('\n📋 Checking Registry Requirements...');

      const requirements = {
        nameCorrect:
          packageJson.name?.includes('plugin-') || packageJson.name.includes('@elizaos/plugin-'),
        hasRepoUrl: !!packageJson.repository?.url,
        correctRepoUrl:
          packageJson.repository?.url?.includes('github:') &&
          !packageJson.repository?.url?.includes('.git'),
        hasImagesDir: existsSync(path.join(cwd, 'images')),
        hasLogoImage: existsSync(path.join(cwd, 'images', 'logo.jpg')),
        hasBannerImage: existsSync(path.join(cwd, 'images', 'banner.jpg')),
        hasAgentConfig: !!packageJson.agentConfig,
        hasDescription: !!packageJson.description,
        hasCorrectStructure:
          existsSync(path.join(cwd, 'src')) && existsSync(path.join(cwd, 'src', 'index.ts')),
      };

      // Check if description is generic/template value
      let isGenericDescription =
        packageJson.description === 'Plugin starter for elizaOS' ||
        !packageJson.description ||
        packageJson.description.length < 10;

      // Only prompt for description in non-test mode and ensure it's done before other checks
      if (isGenericDescription && !opts.test) {
        // Use readline directly instead of prompts to avoid the display issue
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });

        console.info('\n📝 Enter a meaningful description for your plugin:');

        const newDescription = await new Promise<string>((resolve) => {
          rl.question('', (answer) => {
            rl.close();
            resolve(answer.trim());
          });
        });

        if (newDescription && newDescription.length >= 10) {
          packageJson.description = newDescription;
          await fs.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2));
          console.log('Updated description in package.json');
          isGenericDescription = false;
        } else {
          console.warn(
            'Description must be at least 10 characters. Please update your package.json before publishing.'
          );
        }
      }

      // Check if any requirements are missing
      const userProvidedMissing = [
        requirements.hasLogoImage,
        requirements.hasBannerImage,
        !isGenericDescription,
      ].some((req) => !req);

      // Check if any template-provided requirements are missing
      const templateProvidedMissing = [
        requirements.nameCorrect,
        requirements.hasRepoUrl,
        requirements.correctRepoUrl,
        requirements.hasImagesDir,
        requirements.hasAgentConfig,
        requirements.hasCorrectStructure,
      ].some((req) => !req);

      // First display all the requirements status
      console.info('\n🔍 Registry Requirements Status:');

      // Core requirements (should automatically pass due to template)
      console.info(
        `${requirements.nameCorrect ? '✅' : '❓'} Plugin name format (${packageJson.name})`
      );
      console.info(
        `${requirements.hasRepoUrl && requirements.correctRepoUrl ? '✅' : '❓'} Repository URL format is correct`
      );
      console.info(`${requirements.hasAgentConfig ? '✅' : '❓'} AgentConfig in package.json`);
      console.info(
        `${requirements.hasCorrectStructure ? '✅' : '❓'} Directory structure is correct`
      );

      // User-provided assets and configuration
      console.info(`${requirements.hasLogoImage ? '✅' : '❌'} Images/logo.jpg (400x400px)`);
      console.info(`${requirements.hasBannerImage ? '✅' : '❌'} Images/banner.jpg (1280x640px)`);
      console.info(`${isGenericDescription ? '❌' : '✅'} Meaningful description in package.json`);

      // Now show warnings for missing items
      if (userProvidedMissing) {
        console.warn('\n⚠️ Please add the following:');

        if (!requirements.hasLogoImage) {
          console.warn('• Missing images/logo.jpg (400x400px, max 500KB)');
        }
        if (!requirements.hasBannerImage) {
          console.warn('• Missing images/banner.jpg (1280x640px, max 1MB)');
        }

        // Only show this warning if we didn't already update it
        if (isGenericDescription) {
          console.warn(
            '• Add a meaningful description to package.json - explain what your plugin does'
          );
        }

        if (opts.test) {
          console.info(
            '\n📝 Please add these files/information and run "elizaos plugin publish --test" again.'
          );
          return;
        } else {
          // If not in test mode, use readline directly instead of prompts to avoid the issue
          console.warn('\n⚠️ Your plugin is missing required files and may be rejected.');
          console.warn('Do you want to continue anyway? (y/N)');

          const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
          });

          const shouldContinue = await new Promise<boolean>((resolve) => {
            rl.question('', (answer) => {
              rl.close();
              const input = answer.trim().toLowerCase();
              resolve(input === 'y' || input === 'yes');
            });
          });

          if (!shouldContinue) {
            console.info('\n📝 Please add the missing files and try again when ready.');
            process.exit(0);
          }

          console.warn('\n⚠️ Proceeding with incomplete requirements. Your PR may be rejected.');
        }
      }

      if (templateProvidedMissing) {
        console.warn('\n⚠️ Some template-provided requirements are missing:');

        if (!requirements.nameCorrect) {
          console.warn('• Plugin name should include "plugin-" prefix');
        }
        if (!requirements.hasRepoUrl || !requirements.correctRepoUrl) {
          console.warn('• Repository URL should use "github:" prefix format');
        }
        if (!requirements.hasImagesDir) {
          console.warn('• Images directory is missing');
        }
        if (!requirements.hasAgentConfig) {
          console.warn('• Missing agentConfig in package.json');
        }
        if (!requirements.hasCorrectStructure) {
          console.warn('• Incorrect directory structure');
        }

        if (!opts.test) {
          const { shouldFix } = await prompts({
            type: 'confirm',
            name: 'shouldFix',
            message: 'Would you like to fix these template issues automatically?',
            initial: true,
          });

          if (shouldFix) {
            // Fix missing requirements

            // Create images directory if it doesn't exist
            if (!requirements.hasImagesDir) {
              await fs.mkdir(path.join(cwd, 'images'), { recursive: true });
              console.log('Created images/ directory.');
            }

            // Create README.md in images directory with guidelines
            const readmePath = path.join(cwd, 'images', 'README.md');
            if (!existsSync(readmePath)) {
              await fs.writeFile(
                readmePath,
                `# Required Images for ElizaOS Plugins

Please add the following required images to this directory:

## logo.jpg

- **Size**: 400x400px square
- **Max size**: 500KB
- **Purpose**: Main logo for your plugin displayed in the registry and UI

## banner.jpg

- **Size**: 1280x640px (2:1 aspect ratio)
- **Max size**: 1MB
- **Purpose**: Banner image for your plugin displayed in the registry

## Guidelines

- Use clear, high-resolution images
- Keep file sizes optimized
- Follow the ElizaOS brand guidelines
- Include alt text in your documentation for accessibility

These files are required for registry submission. Your plugin submission will not be accepted without these images.
`
              );
              console.log('Created images/README.md with guidelines.');
            }

            // Placeholder image warning
            if (!requirements.hasLogoImage || !requirements.hasBannerImage) {
              console.warn('Missing required images:');
              if (!requirements.hasLogoImage) {
                console.warn('- images/logo.jpg (400x400px, max 500KB)');
              }
              if (!requirements.hasBannerImage) {
                console.warn('- images/banner.jpg (1280x640px, max 1MB)');
              }
              console.warn('Please create these images before publishing.');
            }

            // Fix package.json
            let packageUpdated = false;

            // Add agentConfig if missing
            if (!requirements.hasAgentConfig) {
              packageJson.agentConfig = {
                pluginType: 'elizaos:plugin:1.0.0',
                pluginParameters: {
                  API_KEY: {
                    type: 'string',
                    description: 'API key for the service',
                  },
                },
              };
              packageUpdated = true;
              console.log('Added agentConfig to package.json.');
            }

            // Fix repository URL format
            if (!requirements.correctRepoUrl && requirements.hasRepoUrl) {
              const repoUrl = packageJson.repository.url;
              // Convert https://github.com/user/repo.git to github:user/repo
              let newUrl = repoUrl;
              if (repoUrl.includes('github.com')) {
                newUrl = repoUrl
                  .replace(/https?:\/\/github\.com\//, 'github:')
                  .replace(/\.git$/, '');
                packageJson.repository.url = newUrl;
                packageUpdated = true;
                console.log(`Fixed repository URL format: ${newUrl}`);
              }
            }

            // Save package.json if updated
            if (packageUpdated) {
              await fs.writeFile(
                path.join(cwd, 'package.json'),
                JSON.stringify(packageJson, null, 2)
              );
              console.log('Updated package.json with required changes.');
            }

            // Check and possibly create GitHub repository
            if (!requirements.hasRepoUrl || !requirements.correctRepoUrl) {
              const credentials = await getGitHubCredentials();

              if (!credentials) {
                console.error('GitHub credentials required to create repository.');
                return;
              }

              const pluginName = packageJson.name.replace('@elizaos/', '');
              const repoName = pluginName;

              console.info(`\n📝 Creating GitHub repository for ${pluginName}...`);

              const result = await createGitHubRepository(
                credentials.token,
                repoName,
                packageJson.description || `${pluginName} - ElizaOS plugin`,
                false, // public repository
                ['elizaos-plugins'] // topics
              );

              if (result.success) {
                // Format repository URL for package.json
                const githubUrl = result.repoUrl
                  .replace(/https?:\/\/github\.com\//, 'github:')
                  .replace(/\.git$/, '');

                // Update package.json with the new repository URL
                packageJson.repository = {
                  type: 'git',
                  url: githubUrl,
                };

                await fs.writeFile(
                  path.join(cwd, 'package.json'),
                  JSON.stringify(packageJson, null, 2)
                );

                console.log(`Updated package.json with GitHub repository: ${githubUrl}`);

                // Push code to GitHub
                console.info('\n🚀 Pushing code to GitHub...');
                const pushResult = await pushToGitHub(cwd, result.repoUrl, 'main');

                if (pushResult) {
                  console.log('Successfully pushed code to GitHub!');
                  console.info('\n✨ Please make sure to:');
                  console.info('1. Verify your repository is public');
                  console.info('2. Confirm "main" is the default branch');
                  console.info('3. Add "elizaos-plugins" to repository topics');
                  console.info(
                    '4. Create required logo.jpg and banner.jpg in the images/ directory'
                  );
                } else {
                  console.error('Failed to push code to GitHub. Please push manually.');
                }
              } else {
                console.error(`Failed to create GitHub repository: ${result.message}`);
              }
            }

            // Remind about missing directory structure
            if (!requirements.hasCorrectStructure) {
              console.warn('Your plugin should have this directory structure:');
              console.warn('plugin-name/');
              console.warn('├── images/');
              console.warn('│   ├── logo.jpg');
              console.warn('│   ├── banner.jpg');
              console.warn('├── src/');
              console.warn('│   ├── index.ts');
              console.warn('│   ├── actions/');
              console.warn('│   ├── clients/');
              console.warn('│   ├── adapters/');
              console.warn('│   └── types.ts');
              console.warn('│   └── environment.ts');
              console.warn('├── package.json');
              console.warn('└── README.md');
            }

            // Check again after fixes
            console.info('\n📋 Rechecking requirements...');

            const updatedRequirements = {
              nameCorrect:
                packageJson.name?.includes('plugin-') ||
                packageJson.name.includes('@elizaos/plugin-'),
              hasRepoUrl: !!packageJson.repository?.url,
              correctRepoUrl:
                packageJson.repository?.url?.includes('github:') &&
                !packageJson.repository?.url?.includes('.git'),
              hasImagesDir: existsSync(path.join(cwd, 'images')),
              hasLogoImage: existsSync(path.join(cwd, 'images', 'logo.jpg')),
              hasBannerImage: existsSync(path.join(cwd, 'images', 'banner.jpg')),
              hasAgentConfig: !!packageJson.agentConfig,
              hasDescription: !!packageJson.description,
              hasCorrectStructure:
                existsSync(path.join(cwd, 'src')) && existsSync(path.join(cwd, 'src', 'index.ts')),
            };

            const stillHasMissingRequirements = Object.values(updatedRequirements).some(
              (val) => !val
            );

            if (stillHasMissingRequirements) {
              console.warn('\n⚠️ Some requirements still need to be fixed manually:');

              if (!updatedRequirements.hasLogoImage || !updatedRequirements.hasBannerImage) {
                console.warn('- Create the required images:');
                if (!updatedRequirements.hasLogoImage) {
                  console.warn('  * images/logo.jpg (400x400px, max 500KB)');
                }
                if (!updatedRequirements.hasBannerImage) {
                  console.warn('  * images/banner.jpg (1280x640px, max 1MB)');
                }
              }

              if (!updatedRequirements.hasDescription) {
                console.warn('- Add a description in package.json');
              }

              if (!updatedRequirements.hasCorrectStructure) {
                console.warn('- Ensure your src directory has the correct structure');
              }

              console.info('\nPlease fix these issues before publishing.');
              return;
            }

            console.log('\n✅ All registry requirements are now met! You can publish your plugin.');
          } else {
            console.info('Please fix the missing requirements before publishing.');
            return;
          }
        }
      } else {
        console.log('\n✅ All registry requirements are met!');
      }

      // Get CLI version for runtime compatibility
      const cliPackageJsonPath = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '../package.json'
      );

      let cliVersion = '0.0.0';
      try {
        const cliPackageJsonContent = await fs.readFile(cliPackageJsonPath, 'utf-8');
        const cliPackageJson = JSON.parse(cliPackageJsonContent);
        cliVersion = cliPackageJson.version || '0.0.0';
      } catch (error) {
        console.warn('Could not determine CLI version, using 0.0.0');
      }

      // Refresh GitHub credentials if needed
      if (!credentials.token) {
        console.info('\nGitHub credentials required for publishing.');
        console.info('Please enter your GitHub credentials:\n');

        await new Promise((resolve) => setTimeout(resolve, 10));

        const newCredentials = await getGitHubCredentials();
        if (!newCredentials) {
          process.exit(1);
        }

        credentials = newCredentials;
      }

      // Update registry settings
      const settings = await getRegistrySettings();
      settings.defaultRegistry = opts.registry;
      settings.publishConfig = {
        registry: opts.registry,
        username: credentials.username,
        useNpm: opts.npm,
        platform: opts.platform,
      };
      await saveRegistrySettings(settings);

      // Update the repository URL with the user's GitHub username if needed
      if (packageJson.repository && packageJson.repository.url) {
        // Check if the URL contains 'elizaos-plugins' and not the user's username
        if (
          packageJson.repository.url.includes('elizaos-plugins') &&
          !packageJson.repository.url.includes(username)
        ) {
          const currentUrl = packageJson.repository.url;
          const pluginName = packageJson.name.replace('@elizaos/', '');

          // Update to use the authenticated user's GitHub username
          packageJson.repository.url = currentUrl.replace('elizaos-plugins', username);

          // Write the updated package.json back to disk
          await fs.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2));
          console.info(`Updated repository URL to use your GitHub username (${username})`);
        }
      }

      if (opts.test) {
        // Only run the tests if all user-provided requirements are met
        console.info('\n🧪 Running publish tests...');

        if (opts.npm) {
          console.info('\nTesting npm publishing:');
          const npmTestSuccess = await testPublishToNpm(cwd);
          if (!npmTestSuccess) {
            console.error('npm publishing test failed');
            process.exit(1);
          }
        }

        console.info('\nTesting GitHub publishing:');
        const githubTestSuccess = await testPublishToGitHub(cwd, packageJson, credentials.username);

        if (!githubTestSuccess) {
          console.error('GitHub publishing test failed');
          process.exit(1);
        }

        console.log('\n✅ All tests passed successfully!');
        console.info('\n📝 Your plugin is ready to be published!');
        console.info('Run "npx elizaos plugin publish" to publish your plugin to the registry.');
        return;
      }

      // For the actual publish, we first run the checks with --test to ensure everything's in order
      console.info('\n🔍 Running final checks before publishing...');
      const checkResult = await testPublishToGitHub(cwd, packageJson, credentials.username);
      if (!checkResult) {
        console.error('Final checks failed. Please run with --test flag to debug');
        process.exit(1);
      }
      console.log('✅ Final checks passed!');

      // Check if the plugin has a GitHub repository already, if not create one
      if (!packageJson.repository?.url || !packageJson.repository.url.startsWith('github:')) {
        console.info('\n🚀 Setting up GitHub repository for plugin...');

        // Extract plugin name for repository creation
        const pluginName = packageJson.name.replace('@elizaos/', '');

        // Create a GitHub repository
        const result = await createGitHubRepository(
          credentials.token,
          pluginName,
          packageJson.description || `${pluginName} - ElizaOS plugin`,
          false, // public repository
          ['elizaos-plugins'] // topics
        );

        if (!result.success) {
          console.error(`Failed to create GitHub repository: ${result.message}`);
          process.exit(1);
        }

        const githubUrl = result.repoUrl
          .replace(/https?:\/\/github\.com\//, 'github:')
          .replace(/\.git$/, '');

        // Update package.json with the new repository URL
        packageJson.repository = {
          type: 'git',
          url: githubUrl,
        };

        await fs.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2));
        console.log(`Updated package.json with GitHub repository: ${githubUrl}`);

        // Push code to GitHub repository
        console.info('\n📤 Pushing code to GitHub repository...');

        // Use a more Git-friendly approach without force pushing
        try {
          // Initialize git repo if needed
          await execa('git', ['init'], { cwd });
          console.info('Git repository initialized');

          // Create and checkout main branch
          await execa('git', ['checkout', '-b', 'main'], { cwd });
          console.info('Created main branch');

          // Add remote
          await execa('git', ['remote', 'add', 'origin', result.repoUrl], { cwd });
          console.info(`Added remote: ${result.repoUrl}`);

          // Add all files
          await execa('git', ['add', '.'], { cwd });
          console.info('Added files to git');

          // Commit changes
          await execa('git', ['commit', '-m', 'Initial commit'], { cwd });
          console.info('Committed changes');

          // Check if remote is empty before pushing
          const remoteCheck = await execa('git', ['ls-remote', '--heads', 'origin'], {
            cwd,
            stdio: 'pipe',
            reject: false,
          });

          if (remoteCheck.exitCode === 0 && remoteCheck.stdout.trim() === '') {
            // Remote exists but is empty, safe to push
            console.info('Remote repository is empty, pushing initial commit...');
            await execa('git', ['push', '-u', 'origin', 'main'], { cwd });
            console.log('✅ Successfully pushed code to GitHub repository!');
          } else {
            // Remote has content, create a new branch instead of pushing to main
            const setupBranch = `setup-${Date.now()}`;
            console.info(`Remote repository contains content, creating branch: ${setupBranch}`);
            await execa('git', ['checkout', '-b', setupBranch], { cwd });
            await execa('git', ['push', '-u', 'origin', setupBranch], { cwd });
            console.log(
              `✅ Pushed code to branch '${setupBranch}'. Please merge this branch into main.`
            );
          }
        } catch (error) {
          console.error('Failed to push to GitHub:', error.message);
          console.info('You may need to manually push your code to GitHub');

          const { shouldContinue } = await prompts({
            type: 'confirm',
            name: 'shouldContinue',
            message: 'Continue with publishing to registry anyway?',
            initial: false,
          });

          if (!shouldContinue) {
            process.exit(1);
          }
        }
      } else {
        // Repository URL exists, but we should verify repo actually exists on GitHub
        console.info('\n🔍 Verifying GitHub repository exists...');

        try {
          // Convert github:username/repo to https://github.com/username/repo
          const repoUrlParts = packageJson.repository.url.replace('github:', '').split('/');
          const repoOwner = repoUrlParts[0];
          const repoName = repoUrlParts[1];

          const response = await fetch(`https://api.github.com/repos/${repoOwner}/${repoName}`, {
            headers: {
              Authorization: `token ${credentials.token}`,
              Accept: 'application/vnd.github.v3+json',
            },
          });

          if (!response.ok) {
            if (response.status === 404) {
              console.info(
                `Repository ${packageJson.repository.url} does not exist. Creating it now...`
              );

              // Create repository with the same name
              const result = await createGitHubRepository(
                credentials.token,
                repoName,
                packageJson.description || `${repoName} - ElizaOS plugin`,
                false, // public repository
                ['elizaos-plugins'] // topics
              );

              if (!result.success) {
                console.error(`Failed to create GitHub repository: ${result.message}`);
                process.exit(1);
              }

              // Push code to GitHub repository
              console.info('\n📤 Pushing code to GitHub repository...');

              // Use the more Git-friendly approach
              try {
                // Initialize git repo if needed
                await execa('git', ['init'], { cwd });
                console.info('Git repository initialized');

                // Create and checkout main branch
                await execa('git', ['checkout', '-b', 'main'], { cwd });
                console.info('Created main branch');

                // Add remote
                await execa('git', ['remote', 'add', 'origin', result.repoUrl], { cwd });
                console.info(`Added remote: ${result.repoUrl}`);

                // Add all files
                await execa('git', ['add', '.'], { cwd });
                console.info('Added files to git');

                // Commit changes
                await execa('git', ['commit', '-m', 'Initial commit'], { cwd });
                console.info('Committed changes');

                // Check if remote is empty before pushing
                const remoteCheck = await execa('git', ['ls-remote', '--heads', 'origin'], {
                  cwd,
                  stdio: 'pipe',
                  reject: false,
                });

                if (remoteCheck.exitCode === 0 && remoteCheck.stdout.trim() === '') {
                  // Remote exists but is empty, safe to push
                  console.info('Remote repository is empty, pushing initial commit...');
                  await execa('git', ['push', '-u', 'origin', 'main'], { cwd });
                  console.log('✅ Successfully pushed code to GitHub repository!');
                } else {
                  // Remote has content, create a new branch instead of pushing to main
                  const setupBranch = `setup-${Date.now()}`;
                  console.info(
                    `Remote repository contains content, creating branch: ${setupBranch}`
                  );
                  await execa('git', ['checkout', '-b', setupBranch], { cwd });
                  await execa('git', ['push', '-u', 'origin', setupBranch], { cwd });
                  console.log(
                    `✅ Pushed code to branch '${setupBranch}'. Please merge this branch into main.`
                  );
                }
              } catch (error) {
                console.error('Failed to push to GitHub:', error.message);
                console.info('You may need to manually push your code to GitHub');

                const { shouldContinue } = await prompts({
                  type: 'confirm',
                  name: 'shouldContinue',
                  message: 'Continue with publishing to registry anyway?',
                  initial: false,
                });

                if (!shouldContinue) {
                  process.exit(1);
                }
              }
            } else {
              console.error(
                `Error verifying repository: ${response.status} ${response.statusText}`
              );
              process.exit(1);
            }
          } else {
            console.log('✅ GitHub repository verified!');
          }
        } catch (error) {
          console.error('Error verifying GitHub repository:', error);
          process.exit(1);
        }
      }

      // Handle npm publishing
      if (opts.npm) {
        console.info('Publishing to npm...');

        // Check if logged in to npm
        try {
          await execa('npm', ['whoami'], { stdio: 'inherit' });
        } catch (error) {
          console.error("Not logged in to npm. Please run 'npm login' first.");
          process.exit(1);
        }

        // Build the package
        console.info('Building package...');
        await execa('npm', ['run', 'build'], { cwd, stdio: 'inherit' });

        // Publish to npm
        console.info('Publishing to npm...');
        await execa('npm', ['publish'], { cwd, stdio: 'inherit' });

        console.log(`Successfully published ${packageJson.name}@${packageJson.version} to npm`);
      } else {
        // Even if not explicitly publishing to npm, we should build the package
        console.info('Building package...');
        try {
          await execa('npm', ['run', 'build'], { cwd, stdio: 'inherit' });
          console.log('Build completed successfully');
        } catch (error) {
          console.error('Failed to build package. Please check your build script.');
          const { shouldContinue } = await prompts({
            type: 'confirm',
            name: 'shouldContinue',
            message: 'Continue with publishing to registry anyway?',
            initial: false,
          });

          if (!shouldContinue) {
            process.exit(1);
          }
        }
      }

      // Now publish to the ElizaOS registry
      console.info('\n🚀 Publishing to ElizaOS registry...');
      const result = await publishToGitHub(
        cwd,
        packageJson,
        cliVersion,
        credentials.username,
        false
      );

      if (!result || (typeof result === 'boolean' && !result)) {
        console.error('Failed to publish to ElizaOS registry.');
        process.exit(1);
      }

      console.log(
        `\n🎉 Successfully published ${packageJson.name}@${packageJson.version} to the registry!`
      );

      // Show PR URL if available
      if (result && typeof result === 'object' && result.prUrl) {
        console.info(`\n📝 Pull request created: ${result.prUrl}`);
        console.info('Please visit this URL to track your plugin submission.');
      } else {
        console.info('\nA pull request has been created to add your plugin to the registry.');
      }

      console.info(
        'The ElizaOS team will review your plugin and merge it if it meets all requirements.'
      );
      console.info('\nThank you for contributing to the ElizaOS ecosystem! 🙌');
    } catch (error) {
      handleError(error);
    }
  });

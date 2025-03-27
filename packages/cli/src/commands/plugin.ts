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
    name: packageJson.name.includes('plugin-'),
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
    logger.info('\nGitHub credentials required for publishing.');
    logger.info("You'll need a GitHub Personal Access Token with these scopes:");
    logger.info('  * repo (for repository access)');
    logger.info('  * read:org (for organization access)');
    logger.info('  * workflow (for workflow access)\n');

    await initializeDataDir();

    const credentials = await getGitHubCredentials();
    if (!credentials) {
      logger.error('GitHub credentials setup cancelled.');
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
      logger.error('Invalid GitHub token. Please enter a valid token.');
      process.exit(1);
    }

    // Get the username from the response
    const data = await response.json();
    const username = data.login;

    // Set the username in the environment for other parts of the code to use
    process.env.GITHUB_USERNAME = username;

    return { token, username };
  } catch (error) {
    logger.error('Error authenticating with GitHub. Please try again later.');
    process.exit(1);
  }
}

plugin
  .command('publish')
  .description('publish a plugin to a registry')
  .option('-r, --registry <registry>', 'target registry', 'elizaOS/registry')
  .option('-n, --npm', 'publish to npm instead of GitHub', false)
  .option('-t, --test', 'test publish process without making changes', false)
  .option(
    '-p, --platform <platform>',
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
        logger.info('\nGitHub credentials required for publishing.');
        logger.info("You'll need a GitHub Personal Access Token with these scopes:");
        logger.info('  * repo (for repository access)');
        logger.info('  * read:org (for organization access)');
        logger.info('  * workflow (for workflow access)\n');

        // Initialize data directory first
        await initializeDataDir();

        // Use the built-in credentials function
        const credentials = await getGitHubCredentials();
        if (!credentials) {
          logger.error('GitHub credentials setup cancelled.');
          process.exit(1);
        }

        // Revalidate after saving credentials
        const revalidated = await validateDataDir();
        if (!revalidated) {
          logger.error('Failed to validate credentials after saving.');
          process.exit(1);
        }
      }

      // Check if this is a plugin directory
      const packageJsonPath = path.join(cwd, 'package.json');
      if (!existsSync(packageJsonPath)) {
        logger.error('No package.json found in current directory.');
        process.exit(1);
      }

      // Read package.json
      const packageJsonContent = await fs.readFile(packageJsonPath, 'utf-8');
      const packageJson = JSON.parse(packageJsonContent);

      if (!packageJson.name || !packageJson.version) {
        logger.error('Invalid package.json: missing name or version.');
        process.exit(1);
      }

      // Validate platform option
      const validPlatforms = ['node', 'browser', 'universal'];
      if (opts.platform && !validPlatforms.includes(opts.platform)) {
        logger.error(
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
        logger.error('GitHub credentials are required for publishing plugins.');
        return;
      }

      // Check registry requirements
      logger.info('\n📋 Checking Registry Requirements...');

      const requirements = {
        nameCorrect: packageJson.name?.includes('plugin-'),
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
        logger.info('\n📝 Your plugin needs a meaningful description:');

        const { newDescription } = await prompts({
          type: 'text',
          name: 'newDescription',
          message: 'Enter a meaningful description for your plugin:',
          validate: (input) =>
            input.length >= 10 ? true : 'Description must be at least 10 characters',
        });

        if (newDescription) {
          packageJson.description = newDescription;
          await fs.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2));
          logger.success('Updated description in package.json');
          isGenericDescription = false;
        } else {
          logger.warn('Please add a meaningful description to your package.json before publishing');
        }
      }

      // Display requirements status
      logger.info('\n🔍 Registry Requirements Status:');

      // Core requirements (should automatically pass due to template)
      logger.info(
        `${requirements.nameCorrect ? '✅' : '❓'} Plugin name format (${packageJson.name})`
      );
      logger.info(
        `${requirements.hasRepoUrl && requirements.correctRepoUrl ? '✅' : '❓'} Repository URL format is correct`
      );
      logger.info(`${requirements.hasAgentConfig ? '✅' : '❓'} AgentConfig in package.json`);
      logger.info(
        `${requirements.hasCorrectStructure ? '✅' : '❓'} Directory structure is correct`
      );

      // User-provided assets and configuration
      logger.info(`${requirements.hasLogoImage ? '✅' : '❌'} Images/logo.jpg (400x400px)`);
      logger.info(`${requirements.hasBannerImage ? '✅' : '❌'} Images/banner.jpg (1280x640px)`);
      logger.info(`${isGenericDescription ? '❌' : '✅'} Meaningful description in package.json`);

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

      if (userProvidedMissing) {
        logger.warn('\n⚠️ Please add the following:');

        if (!requirements.hasLogoImage) {
          logger.warn('• Missing images/logo.jpg (400x400px, max 500KB)');
        }
        if (!requirements.hasBannerImage) {
          logger.warn('• Missing images/banner.jpg (1280x640px, max 1MB)');
        }

        // Only show this warning if we didn't already update it
        if (isGenericDescription) {
          logger.warn(
            '• Add a meaningful description to package.json - explain what your plugin does'
          );
        }

        logger.info(
          '\n📝 Please add these files/information and run "elizaos plugin publish --test" again.'
        );

        // Skip the rest of the process if this is a test and requirements are missing
        if (opts.test) {
          return;
        }
      }

      if (templateProvidedMissing) {
        logger.warn('\n⚠️ Some template-provided requirements are missing:');

        if (!requirements.nameCorrect) {
          logger.warn('• Plugin name should include "plugin-" prefix');
        }
        if (!requirements.hasRepoUrl || !requirements.correctRepoUrl) {
          logger.warn('• Repository URL should use "github:" prefix format');
        }
        if (!requirements.hasImagesDir) {
          logger.warn('• Images directory is missing');
        }
        if (!requirements.hasAgentConfig) {
          logger.warn('• Missing agentConfig in package.json');
        }
        if (!requirements.hasCorrectStructure) {
          logger.warn('• Incorrect directory structure');
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
              logger.success('Created images/ directory.');
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
              logger.success('Created images/README.md with guidelines.');
            }

            // Placeholder image warning
            if (!requirements.hasLogoImage || !requirements.hasBannerImage) {
              logger.warn('Missing required images:');
              if (!requirements.hasLogoImage) {
                logger.warn('- images/logo.jpg (400x400px, max 500KB)');
              }
              if (!requirements.hasBannerImage) {
                logger.warn('- images/banner.jpg (1280x640px, max 1MB)');
              }
              logger.warn('Please create these images before publishing.');
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
              logger.success('Added agentConfig to package.json.');
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
                logger.success(`Fixed repository URL format: ${newUrl}`);
              }
            }

            // Save package.json if updated
            if (packageUpdated) {
              await fs.writeFile(
                path.join(cwd, 'package.json'),
                JSON.stringify(packageJson, null, 2)
              );
              logger.success('Updated package.json with required changes.');
            }

            // Check and possibly create GitHub repository
            if (!requirements.hasRepoUrl || !requirements.correctRepoUrl) {
              const credentials = await getGitHubCredentials();

              if (!credentials) {
                logger.error('GitHub credentials required to create repository.');
                return;
              }

              const pluginName = packageJson.name.replace('@elizaos/', '');
              const repoName = pluginName;

              logger.info(`\n📝 Creating GitHub repository for ${pluginName}...`);

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

                logger.success(`Updated package.json with GitHub repository: ${githubUrl}`);

                // Push code to GitHub
                logger.info('\n🚀 Pushing code to GitHub...');
                const pushResult = await pushToGitHub(cwd, result.repoUrl, 'main');

                if (pushResult) {
                  logger.success('Successfully pushed code to GitHub!');
                  logger.info('\n✨ Please make sure to:');
                  logger.info('1. Verify your repository is public');
                  logger.info('2. Confirm "main" is the default branch');
                  logger.info('3. Add "elizaos-plugins" to repository topics');
                  logger.info(
                    '4. Create required logo.jpg and banner.jpg in the images/ directory'
                  );
                } else {
                  logger.error('Failed to push code to GitHub. Please push manually.');
                }
              } else {
                logger.error(`Failed to create GitHub repository: ${result.message}`);
              }
            }

            // Remind about missing directory structure
            if (!requirements.hasCorrectStructure) {
              logger.warn('Your plugin should have this directory structure:');
              logger.warn('plugin-name/');
              logger.warn('├── images/');
              logger.warn('│   ├── logo.jpg');
              logger.warn('│   ├── banner.jpg');
              logger.warn('├── src/');
              logger.warn('│   ├── index.ts');
              logger.warn('│   ├── actions/');
              logger.warn('│   ├── clients/');
              logger.warn('│   ├── adapters/');
              logger.warn('│   └── types.ts');
              logger.warn('│   └── environment.ts');
              logger.warn('├── package.json');
              logger.warn('└── README.md');
            }

            // Check again after fixes
            logger.info('\n📋 Rechecking requirements...');

            const updatedRequirements = {
              nameCorrect: packageJson.name?.includes('plugin-'),
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
              logger.warn('\n⚠️ Some requirements still need to be fixed manually:');

              if (!updatedRequirements.hasLogoImage || !updatedRequirements.hasBannerImage) {
                logger.warn('- Create the required images:');
                if (!updatedRequirements.hasLogoImage) {
                  logger.warn('  * images/logo.jpg (400x400px, max 500KB)');
                }
                if (!updatedRequirements.hasBannerImage) {
                  logger.warn('  * images/banner.jpg (1280x640px, max 1MB)');
                }
              }

              if (!updatedRequirements.hasDescription) {
                logger.warn('- Add a description in package.json');
              }

              if (!updatedRequirements.hasCorrectStructure) {
                logger.warn('- Ensure your src directory has the correct structure');
              }

              logger.info('\nPlease fix these issues before publishing.');
              return;
            }

            logger.success(
              '\n✅ All registry requirements are now met! You can publish your plugin.'
            );
          } else {
            logger.info('Please fix the missing requirements before publishing.');
            return;
          }
        } else {
          // In test mode, just focus on user-provided requirements
          if (userProvidedMissing) {
            logger.info('\n📝 To complete your plugin, you need to:');

            if (!requirements.hasLogoImage) {
              logger.info('• Add images/logo.jpg (400x400px, max 500KB)');
            }
            if (!requirements.hasBannerImage) {
              logger.info('• Add images/banner.jpg (1280x640px, max 1MB)');
            }
            if (isGenericDescription) {
              logger.info(
                '• Add a meaningful description to package.json - explain what your plugin does'
              );
            }

            logger.info(
              '\nAfter adding these, run "elizaos plugin publish --test" again to verify.'
            );
            return;
          }
        }
      } else {
        logger.success('\n✅ All registry requirements are met!');
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
        logger.warn('Could not determine CLI version, using 0.0.0');
      }

      // Refresh GitHub credentials if needed
      if (!credentials.token) {
        logger.info('\nGitHub credentials required for publishing.');
        logger.info('Please enter your GitHub credentials:\n');

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
          logger.info(`Updated repository URL to use your GitHub username (${username})`);
        }
      }

      if (opts.test) {
        // Only run the tests if all user-provided requirements are met
        logger.info('\n🧪 Running publish tests...');

        if (opts.npm) {
          logger.info('\nTesting npm publishing:');
          const npmTestSuccess = await testPublishToNpm(cwd);
          if (!npmTestSuccess) {
            logger.error('npm publishing test failed');
            process.exit(1);
          }
        }

        logger.info('\nTesting GitHub publishing:');
        const githubTestSuccess = await testPublishToGitHub(cwd, packageJson, credentials.username);

        if (!githubTestSuccess) {
          logger.error('GitHub publishing test failed');
          process.exit(1);
        }

        logger.success('\n✅ All tests passed successfully!');
        logger.info('\n📝 Your plugin is ready to be published!');
        logger.info('Run "npx elizaos plugin publish" to publish your plugin to the registry.');
        return;
      }

      // Handle npm publishing
      if (opts.npm) {
        logger.info('Publishing to npm...');

        // Check if logged in to npm
        try {
          await execa('npm', ['whoami'], { stdio: 'inherit' });
        } catch (error) {
          logger.error("Not logged in to npm. Please run 'npm login' first.");
          process.exit(1);
        }

        // Build the package
        logger.info('Building package...');
        await execa('npm', ['run', 'build'], { cwd, stdio: 'inherit' });

        // Publish to npm
        logger.info('Publishing to npm...');
        await execa('npm', ['publish'], { cwd, stdio: 'inherit' });

        logger.success(`Successfully published ${packageJson.name}@${packageJson.version} to npm`);
        return;
      }

      // Handle GitHub publishing
      const success = await publishToGitHub(
        cwd,
        packageJson,
        cliVersion,
        credentials.username,
        false
      );

      if (!success) {
        process.exit(1);
      }

      logger.success(
        `\n🎉 Successfully published ${packageJson.name}@${packageJson.version} to the registry!`
      );
      logger.info('\nA pull request has been created to add your plugin to the registry.');
      logger.info(
        'The ElizaOS team will review your plugin and merge it if it meets all requirements.'
      );
    } catch (error) {
      handleError(error);
    }
  });

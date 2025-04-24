import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { logger } from '@elizaos/core';

/**
 * Copy a directory recursively
 */
/**
 * Asynchronously copies the contents of a directory from a source path to a destination path, excluding specified files and directories.
 * If the destination directory does not exist, it will be created.
 *
 * @param {string} src - The path to the source directory.
 * @param {string} dest - The path to the destination directory.
 * @param {string[]} [exclude=[]] - An array of file and directory names to exclude from the copy operation.
 * @returns {Promise<void>} A Promise that resolves when the copy operation is complete.
 */
export async function copyDir(src: string, dest: string, exclude: string[] = []) {
  // Create destination directory if it doesn't exist
  await fs.mkdir(dest, { recursive: true });

  // Read source directory
  const entries = await fs.readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    // Skip excluded directories/files
    if (exclude.includes(entry.name)) {
      continue;
    }

    // Skip node_modules, .git directories and other build artifacts
    if (
      entry.name === 'node_modules' ||
      entry.name === '.git' ||
      entry.name === 'cache' ||
      entry.name === 'data' ||
      entry.name === 'generatedImages' ||
      entry.name === '.turbo'
    ) {
      continue;
    }

    if (entry.isDirectory()) {
      // Recursively copy directory
      await copyDir(srcPath, destPath, exclude);
    } else {
      // Copy file
      await fs.copyFile(srcPath, destPath);
    }
  }
}

/**
 * Copy a project or plugin template to target directory
 */
export async function copyTemplate(
  templateType: 'project' | 'plugin',
  targetDir: string,
  name: string
) {
  // In development mode, use the actual packages
  let templateDir;

  if (process.env.NODE_ENV === 'development') {
    // Use local packages during development
    templateDir = path.resolve(
      process.cwd(),
      'packages',
      templateType === 'project' ? 'project-starter' : 'plugin-starter'
    );
  } else {
    // In production, use the templates directory from the CLI package
    templateDir = path.resolve(
      path.dirname(require.resolve('@elizaos/cli/package.json')),
      'templates',
      templateType === 'project' ? 'project-starter' : 'plugin-starter'
    );
  }

  logger.info(`Copying ${templateType} template from ${templateDir} to ${targetDir}`);

  // Copy template files
  await copyDir(templateDir, targetDir);

  // Explicitly check and copy .gitignore file (hidden files can be missed)
  const srcGitignore = path.join(templateDir, '.gitignore');
  const destGitignore = path.join(targetDir, '.gitignore');
  if (existsSync(srcGitignore) && !existsSync(destGitignore)) {
    await fs.copyFile(srcGitignore, destGitignore);
  }

  // Update package.json with new name and dependency versions
  const packageJsonPath = path.join(targetDir, 'package.json');

  try {
    // get the package.json of this package
    const cliPackageJsonPath = path.resolve(
      path.dirname(require.resolve('@elizaos/cli/package.json')),
      'package.json'
    );

    const cliPackageJson = JSON.parse(await fs.readFile(cliPackageJsonPath, 'utf8'));

    // get the version of this package
    const cliPackageVersion = cliPackageJson.version;

    const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));

    // Set project name
    packageJson.name = name;

    // Use a dedicated field for ElizaOS package type to avoid collision with Node.js module type
    packageJson.packageType = templateType;

    // Ensure the module type is set to 'module' for ES modules
    if (!packageJson.type) {
      packageJson.type = 'module';
    }

    // Process dependencies - set all @elizaos/* packages to use cliPackageVersion
    if (packageJson.dependencies) {
      for (const depName of Object.keys(packageJson.dependencies)) {
        if (depName.startsWith('@elizaos/')) {
          logger.info(`Setting ${depName} to use latest version dynamically`);
          packageJson.dependencies[depName] = cliPackageVersion;
        }
      }
    }

    // Process devDependencies if they exist
    if (packageJson.devDependencies) {
      for (const depName of Object.keys(packageJson.devDependencies)) {
        if (depName.startsWith('@elizaos/')) {
          logger.info(`Setting dev dependency ${depName} to use version ${cliPackageVersion}`);
          packageJson.devDependencies[depName] = cliPackageVersion;
        }
      }
    }

    // Create or update repository URL with the GitHub format
    // Extract the name without scope for the repository URL
    const nameWithoutScope = name.replace('@elizaos/', '');

    // Get the GitHub username from environment if available, or use a default
    const githubUsername = process.env.GITHUB_USERNAME || 'elizaos';

    // Always create/update repository field with proper URL format
    packageJson.repository = {
      type: 'git',
      url: `github:${githubUsername}/${nameWithoutScope}`,
    };

    if (templateType === 'plugin') {
      // Add platform if missing
      if (!packageJson.platform) {
        packageJson.platform = 'universal';
      }

      // Add agentConfig if missing
      if (!packageJson.agentConfig) {
        packageJson.agentConfig = {
          pluginType: 'elizaos:plugin:1.0.0',
          pluginParameters: {
            API_KEY: {
              type: 'string',
              description: 'API key for the service',
            },
          },
        };
      }

      // Create images directory with README
      const imagesDir = path.join(targetDir, 'images');
      if (!existsSync(imagesDir)) {
        await fs.mkdir(imagesDir, { recursive: true });

        // Create README.md in the images directory
        const readmePath = path.join(imagesDir, 'README.md');
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

These files are required for registry submission. Your plugin submission will not be accepted without these images.`
        );
      }

      // Update main README.md with better guidance
      const readmePath = path.join(targetDir, 'README.md');
      await fs.writeFile(
        readmePath,
        `# ElizaOS Plugin

This is an ElizaOS plugin built with the official plugin starter template.

## Development

\`\`\`bash
# Start development with hot-reloading
npm run dev

# Build the plugin
npm run build

# Test the plugin
npm run test
\`\`\`

## Publishing

Before publishing your plugin to the ElizaOS registry, ensure you meet these requirements:

1. **GitHub Repository**
   - Create a public GitHub repository for this plugin
   - Add the 'elizaos-plugins' topic to the repository
   - Use 'main' as the default branch

2. **Required Assets**
   - Add images to the \`images/\` directory:
     - \`logo.jpg\` (400x400px square, <500KB)
     - \`banner.jpg\` (1280x640px, <1MB)

3. **Publishing Process**
   \`\`\`bash
   # Check if your plugin meets all registry requirements
   npx elizaos publish --test
   
   # Publish to the registry
   npx elizaos publish
   \`\`\`

After publishing, your plugin will be submitted as a pull request to the ElizaOS registry for review.

## Configuration

The \`agentConfig\` section in \`package.json\` defines the parameters your plugin requires:

\`\`\`json
"agentConfig": {
  "pluginType": "elizaos:plugin:1.0.0",
  "pluginParameters": {
    "API_KEY": {
      "type": "string",
      "description": "API key for the service"
    }
  }
}
\`\`\`

Customize this section to match your plugin's requirements.

## Documentation

Provide clear documentation about:
- What your plugin does
- How to use it
- Required API keys or credentials
- Example usage
`
      );

      // Update the index.ts file to use the plugin name from package.json
      try {
        const indexTsPath = path.join(targetDir, 'src', 'index.ts');
        let indexTsContent = await fs.readFile(indexTsPath, 'utf8');

        // Extract the plugin name without scope for use in the plugin definition
        const pluginNameWithoutScope = name.replace('@elizaos/', '');
        const description = packageJson.description || 'ElizaOS Plugin';

        // Replace hardcoded plugin name in the starterPlugin export
        indexTsContent = indexTsContent.replace(
          /name: 'plugin-starter',/g,
          `name: '${pluginNameWithoutScope}',`
        );

        // Replace the description if present
        indexTsContent = indexTsContent.replace(
          /description: 'Plugin starter for elizaOS',/g,
          `description: '${description}',`
        );

        await fs.writeFile(indexTsPath, indexTsContent);
        logger.success(`Updated plugin name in index.ts to ${pluginNameWithoutScope}`);
      } catch (error) {
        logger.error(`Error updating index.ts: ${error}`);
      }
    } else if (templateType === 'project') {
      // Add agentConfig for projects if missing
      if (!packageJson.agentConfig) {
        packageJson.agentConfig = {
          pluginType: 'elizaos:project:1.0.0',
          projectConfig: {
            name: name,
            description: packageJson.description || 'An ElizaOS Project',
          },
        };
      }

      // Add repository configuration for projects
      if (!packageJson.repository) {
        // Get the GitHub username from environment if available, or use a default
        const githubUsername = process.env.GITHUB_USERNAME || 'elizaos';

        // Extract the project name without scope for the repository URL
        const projectNameWithoutScope = name.replace('@elizaos/', '');

        // Set the repository URL
        packageJson.repository = {
          type: 'git',
          url: `github:${githubUsername}/${projectNameWithoutScope}`,
        };
      }
    }

    // Write the updated package.json
    await fs.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2));
    logger.success('Updated package.json with project name and latest dependencies');
  } catch (error) {
    logger.error(`Error updating package.json: ${error}`);
  }

  logger.success(`${templateType} template copied successfully`);
}

/**
 * Copy client dist files to the CLI package dist directory
 */
export async function copyClientDist() {
  logger.info('Copying client dist files to CLI package');

  // Determine source and destination paths
  const srcClientDist = path.resolve(process.cwd(), '../client/dist');
  const destClientDist = path.resolve(process.cwd(), './dist');

  // Create destination directory
  await fs.mkdir(destClientDist, { recursive: true });

  // Wait for source directory to exist and have files
  let retries = 0;
  const maxRetries = 10;
  const retryDelay = 1000; // 1 second

  while (retries < maxRetries) {
    if (existsSync(srcClientDist)) {
      const files = await fs.readdir(srcClientDist);
      if (files.length > 0) {
        break;
      }
    }

    logger.info(
      `Waiting for client dist files to be built (attempt ${retries + 1}/${maxRetries})...`
    );
    await new Promise((resolve) => setTimeout(resolve, retryDelay));
    retries++;
  }

  // Check if source exists after retries
  if (!existsSync(srcClientDist)) {
    logger.error(`Client dist not found at ${srcClientDist} after ${maxRetries} attempts`);
    return;
  }

  // Copy client dist files
  await copyDir(srcClientDist, destClientDist);

  logger.success('Client dist files copied successfully');
}

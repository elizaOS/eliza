import { logger } from '@elizaos/core';
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import * as clack from '@clack/prompts';
import { EnvVarConfig } from '../types';
import { createEnvFileService } from '@/src/services/env-file.service';

/**
 * Attempts to find the package.json of an installed plugin and extract environment variable requirements
 * from its agentConfig.pluginParameters
 */
export const extractPluginEnvRequirements = async (
  packageName: string,
  cwd: string
): Promise<Record<string, EnvVarConfig>> => {
  try {
    // Try multiple possible paths for the plugin
    const possiblePaths = [
      // Direct path
      path.join(cwd, 'node_modules', packageName, 'package.json'),
      // Scoped package path (e.g., @elizaos/plugin-discord)
      path.join(cwd, 'node_modules', packageName.replace('/', path.sep), 'package.json'),
    ];

    // If the package name doesn't start with @elizaos/, also try with that prefix
    if (!packageName.startsWith('@elizaos/')) {
      possiblePaths.push(
        path.join(cwd, 'node_modules', '@elizaos', packageName, 'package.json'),
        path.join(cwd, 'node_modules', '@elizaos', `plugin-${packageName}`, 'package.json')
      );
    }

    // Also check if it's installed globally or in a parent directory
    let currentDir = cwd;
    for (let i = 0; i < 5; i++) {
      const parentNodeModules = path.join(currentDir, 'node_modules');
      if (existsSync(parentNodeModules)) {
        possiblePaths.push(
          path.join(parentNodeModules, packageName, 'package.json'),
          path.join(parentNodeModules, packageName.replace('/', path.sep), 'package.json')
        );
      }
      const parentDir = path.dirname(currentDir);
      if (parentDir === currentDir) break; // Reached root
      currentDir = parentDir;
    }

    // Find the first existing path
    let packageJsonPath: string | null = null;
    for (const possiblePath of possiblePaths) {
      if (existsSync(possiblePath)) {
        packageJsonPath = possiblePath;
        logger.debug(`Found plugin package.json at: ${packageJsonPath}`);
        break;
      }
    }

    if (!packageJsonPath) {
      // Try to find any matching package in node_modules
      const nodeModulesPath = path.join(cwd, 'node_modules');
      if (existsSync(nodeModulesPath)) {
        const packages = readdirSync(nodeModulesPath);
        for (const pkg of packages) {
          if (pkg.includes(packageName.replace('@elizaos/', '').replace('plugin-', ''))) {
            const pkgJsonPath = path.join(nodeModulesPath, pkg, 'package.json');
            if (existsSync(pkgJsonPath)) {
              packageJsonPath = pkgJsonPath;
              logger.debug(`Found matching plugin package.json at: ${packageJsonPath}`);
              break;
            }
          }
        }
      }
    }

    if (!packageJsonPath) {
      logger.debug(`Plugin package.json not found for: ${packageName}`);
      logger.debug(`Searched paths: ${possiblePaths.join(', ')}`);
      return {};
    }

    const packageJsonContent = readFileSync(packageJsonPath, 'utf-8');
    const packageJson = JSON.parse(packageJsonContent);

    // Extract environment variables from agentConfig.pluginParameters
    const agentConfig = packageJson.agentConfig;
    if (!agentConfig || !agentConfig.pluginParameters) {
      logger.debug(`No agentConfig.pluginParameters found in ${packageName} at ${packageJsonPath}`);
      return {};
    }

    logger.debug(
      `Found environment variables for ${packageName}: ${Object.keys(agentConfig.pluginParameters).join(', ')}`
    );

    return agentConfig.pluginParameters;
  } catch (error) {
    logger.debug(
      `Error reading plugin package.json for ${packageName}: ${error instanceof Error ? error.message : String(error)}`
    );
    return {};
  }
};

/**
 * Reads the current .env file content
 */
export const readEnvFile = async (cwd: string): Promise<Record<string, string>> => {
  const envPath = path.join(cwd, '.env');
  const envService = createEnvFileService(envPath);
  return envService.read();
};

/**
 * Writes content to the .env file
 */
export const writeEnvFile = async (cwd: string, vars: Record<string, string>): Promise<void> => {
  const envPath = path.join(cwd, '.env');
  const envService = createEnvFileService(envPath);
  await envService.write(vars, {
    preserveComments: false,
    updateProcessEnv: true,
  });
};

/**
 * Extracts default value from description text (e.g., "e.g., fluently-xl" -> "fluently-xl")
 */
const extractDefaultFromDescription = (description: string): string | undefined => {
  const patterns = [
    /\(e\.g\.,\s*([^)]+)\)/i, // (e.g., value)
    /e\.g\.,?\s*([^.,\s]+)/i, // e.g., value or e.g. value
    /example:\s*([^.,\s]+)/i, // example: value
    /default:\s*([^.,\s]+)/i, // default: value
  ];

  for (const pattern of patterns) {
    const match = description.match(pattern);
    if (match && match[1]) {
      return match[1].trim();
    }
  }
  return undefined;
};

/**
 * Prompts user for an environment variable value
 */
export const promptForEnvVar = async (varName: string, config: EnvVarConfig): Promise<string> => {
  const {
    type = 'string',
    description = 'No description available',
    default: explicitDefault,
    sensitive = false,
    required = true, // Default to true for backwards compatibility
  } = config;

  // Determine default value (explicit default takes precedence over extracted default)
  const defaultValue = explicitDefault || extractDefaultFromDescription(description);

  // Use explicit sensitive property, fallback to heuristic if not specified
  const isSecret =
    sensitive !== undefined
      ? sensitive
      : varName.toLowerCase().includes('key') ||
        varName.toLowerCase().includes('token') ||
        varName.toLowerCase().includes('secret') ||
        varName.toLowerCase().includes('password');

  // Show additional context for the environment variable first (for all types)
  if (description && description !== 'No description available') {
    clack.note(`${description}`, `${varName} Info`);
  }

  // Handle boolean type specifically
  if (type === 'boolean') {
    const defaultBool = defaultValue === 'true' || String(explicitDefault).toLowerCase() === 'true';
    const response = await clack.confirm({
      message: required ? `Enable ${varName}?` : `Enable ${varName}? (optional)`,
      initialValue: defaultBool,
    });

    if (clack.isCancel(response)) {
      clack.cancel('Operation cancelled.');
      process.exit(0);
    }

    // For optional booleans, if user cancels/skips, return empty string
    if (!required && response === undefined) {
      return '';
    }

    return String(response);
  }

  // Handle number type
  if (type === 'number') {
    const message = defaultValue
      ? `Enter ${varName} (default: ${String(defaultValue)})`
      : required
        ? `Enter ${varName}`
        : `Enter ${varName} (press Enter to skip)`;

    const promptConfig = {
      message,
      placeholder: required
        ? String(defaultValue || 'Enter a number')
        : String(defaultValue || 'Press Enter to skip'),
      initialValue: defaultValue ? String(defaultValue) : undefined,
      validate: (input: string) => {
        // Allow empty input for optional fields
        if ((!input || input.trim() === '') && !required) {
          return undefined;
        }

        if ((!input || input.trim() === '') && required && !defaultValue) {
          return 'This field cannot be empty. Press Ctrl+C to cancel.';
        }

        // Validate number format
        const trimmed = input.trim();
        if (trimmed && isNaN(Number(trimmed))) {
          return 'Please enter a valid number';
        }

        return undefined;
      },
    };

    const response = await clack.text(promptConfig);

    if (clack.isCancel(response)) {
      clack.cancel('Operation cancelled.');
      process.exit(0);
    }

    const finalValue = (response && response.trim()) || defaultValue || '';
    return finalValue.trim();
  }

  // Handle array type (comma-separated values)
  if (type === 'array') {
    const message = defaultValue
      ? `Enter ${varName} (comma-separated, default: ${String(defaultValue)})`
      : required
        ? `Enter ${varName} (comma-separated values)`
        : `Enter ${varName} (comma-separated values, press Enter to skip)`;

    const promptConfig = {
      message,
      placeholder: required
        ? String(defaultValue || 'value1,value2,value3')
        : String(defaultValue || 'Press Enter to skip'),
      initialValue: defaultValue ? String(defaultValue) : undefined,
      validate: (input: string) => {
        // Allow empty input for optional fields
        if ((!input || input.trim() === '') && !required) {
          return undefined;
        }

        if ((!input || input.trim() === '') && required && !defaultValue) {
          return 'This field cannot be empty. Press Ctrl+C to cancel.';
        }

        return undefined;
      },
    };

    const response = await clack.text(promptConfig);

    if (clack.isCancel(response)) {
      clack.cancel('Operation cancelled.');
      process.exit(0);
    }

    // Clean up the array format
    const finalValue = (response && response.trim()) || defaultValue || '';
    if (finalValue) {
      // Remove spaces after commas for consistency
      return finalValue
        .split(',')
        .map((v) => v.trim())
        .filter((v) => v)
        .join(',');
    }
    return finalValue;
  }

  // Handle JSON object type
  if (type === 'json') {
    clack.log.info('Enter a JSON object. For multi-line input, use the editor.');

    const message = defaultValue
      ? `Enter ${varName} JSON (default: ${String(defaultValue)})`
      : required
        ? `Enter ${varName} JSON`
        : `Enter ${varName} JSON (press Enter to skip)`;

    const promptConfig = {
      message,
      placeholder: required
        ? String(defaultValue || '{"key": "value"}')
        : String(defaultValue || 'Press Enter to skip'),
      initialValue: defaultValue ? String(defaultValue) : undefined,
      validate: (input: string) => {
        // Allow empty input for optional fields
        if ((!input || input.trim() === '') && !required) {
          return undefined;
        }

        if ((!input || input.trim() === '') && required && !defaultValue) {
          return 'This field cannot be empty. Press Ctrl+C to cancel.';
        }

        // Validate JSON format
        if (input && input.trim()) {
          try {
            JSON.parse(input.trim());
          } catch (error) {
            return 'Please enter valid JSON format';
          }
        }

        return undefined;
      },
    };

    const response = await clack.text(promptConfig);

    if (clack.isCancel(response)) {
      clack.cancel('Operation cancelled.');
      process.exit(0);
    }

    const finalValue = (response && response.trim()) || defaultValue || '';
    // Minify JSON for storage in .env
    if (finalValue) {
      try {
        const parsed = JSON.parse(finalValue);
        return JSON.stringify(parsed);
      } catch {
        return finalValue;
      }
    }
    return finalValue;
  }

  // Default string handling (existing code)
  // Create a more informative message with better formatting
  const message = defaultValue
    ? `Enter ${varName} (default: ${String(defaultValue)})`
    : required
      ? `Enter ${varName}`
      : `Enter ${varName} (press Enter to skip)`;

  // Ensure placeholder is always a string
  const placeholder = isSecret
    ? 'Your secret key/token...'
    : required
      ? String(defaultValue || 'Required value')
      : String(defaultValue || 'Press Enter to skip');

  const promptFn = isSecret ? clack.password : clack.text;

  const promptConfig: any = {
    message,
    placeholder,
    validate: (input: string) => {
      // Allow empty input for optional fields
      if ((!input || input.trim() === '') && required && !defaultValue) {
        return 'This field cannot be empty. Press Ctrl+C to cancel.';
      }

      // Skip validation for empty optional fields
      if ((!input || input.trim() === '') && !required) {
        return undefined; // Valid - allow empty for optional fields
      }

      // Basic validation for common patterns
      if (varName.includes('URL') || varName.includes('ENDPOINT')) {
        // Only validate if input is provided
        if (input && input.trim()) {
          try {
            new URL(input.trim());
          } catch {
            return 'Please enter a valid URL (e.g., https://api.example.com)';
          }
        }
      }

      if (varName.includes('API_KEY') && input.trim().length > 0 && input.trim().length < 5) {
        return 'API key seems too short. Please verify you entered the complete key.';
      }

      return undefined;
    },
  };

  // Add default value if available (only for non-secret fields)
  if (defaultValue && !isSecret) {
    promptConfig.initialValue = String(defaultValue);
  }

  const response = await promptFn(promptConfig);

  if (clack.isCancel(response)) {
    clack.cancel('Operation cancelled.');
    process.exit(0);
  }

  // Use default value if user pressed Enter without input
  const finalValue = (response && response.trim()) || defaultValue || '';
  return finalValue.trim();
};

/**
 * Updates the .env file with a new environment variable
 */
export const updateEnvFile = async (cwd: string, varName: string, value: string): Promise<void> => {
  const envPath = path.join(cwd, '.env');
  const envService = createEnvFileService(envPath);

  // Update the environment variable and process.env
  await envService.update(varName, value, {
    preserveComments: true,
    updateProcessEnv: true,
  });
};

/**
 * Prompts for environment variables based on the plugin's agentConfig.pluginParameters
 * and writes them to the .env file
 */
export const promptForPluginEnvVars = async (packageName: string, cwd: string): Promise<void> => {
  let envRequirements = await extractPluginEnvRequirements(packageName, cwd);

  // If no requirements found and package doesn't start with @elizaos/, try with that prefix
  if (Object.keys(envRequirements).length === 0 && !packageName.startsWith('@elizaos/')) {
    // Try with @elizaos/ prefix
    const elizaosPackageName = `@elizaos/${packageName.replace('plugin-', '')}`;
    envRequirements = await extractPluginEnvRequirements(elizaosPackageName, cwd);

    // Also try with @elizaos/plugin- prefix
    if (Object.keys(envRequirements).length === 0) {
      const elizaosPluginPackageName = `@elizaos/plugin-${packageName.replace('plugin-', '')}`;
      envRequirements = await extractPluginEnvRequirements(elizaosPluginPackageName, cwd);
    }
  }

  if (Object.keys(envRequirements).length === 0) {
    // Check if package exists but has no env requirements
    const nodeModulesPath = path.join(cwd, 'node_modules');
    const possiblePackages = [
      packageName,
      `@elizaos/${packageName.replace('plugin-', '')}`,
      `@elizaos/plugin-${packageName.replace('plugin-', '')}`,
    ];

    let packageFound = false;
    for (const pkg of possiblePackages) {
      const pkgPath = path.join(nodeModulesPath, ...pkg.split('/'));
      if (existsSync(path.join(pkgPath, 'package.json'))) {
        packageFound = true;
        break;
      }
    }

    if (packageFound) {
      logger.debug(`Package ${packageName} found but has no environment variables defined`);
      clack.log.success(`No environment variables required for ${packageName}`);
    } else {
      logger.debug(`Package ${packageName} not found in node_modules`);
      clack.log.warn(
        `Could not find ${packageName} in node_modules. Environment variables may need to be configured manually.`
      );
    }
    return;
  }

  // Ensure all previous logs are complete before starting interactive prompts
  await new Promise((resolve) => setTimeout(resolve, 100));

  clack.intro(`Setting up ${packageName} Plugin`);

  // Read current .env file to check for existing values
  const envVars = await readEnvFile(cwd);
  const existingVars: Record<string, string> = envVars;

  // Separate existing and missing variables
  const missingVars: Array<[string, EnvVarConfig]> = [];
  const existingConfigured: string[] = [];

  Object.entries(envRequirements).forEach(([varName, config]) => {
    if (existingVars[varName] && existingVars[varName] !== '') {
      existingConfigured.push(varName);
    } else {
      missingVars.push([varName, config]);
    }
  });

  // Show status of existing variables
  if (existingConfigured.length > 0) {
    clack.note(existingConfigured.map((name) => `${name}`).join('\n'), 'Already Configured');
  }

  // If all variables are already configured, we're done
  if (missingVars.length === 0) {
    clack.outro('All environment variables are already configured!');
    return;
  }

  // Show what needs to be configured with better organization
  const totalVars = Object.keys(envRequirements).length;
  const requiredVars = missingVars.filter(([, config]) => config.required !== false);
  const optionalVars = missingVars.filter(([, config]) => config.required === false);

  let configMessage = `We need to configure ${missingVars.length} of ${totalVars} environment variables.\n\n`;

  if (requiredVars.length > 0) {
    configMessage += `Required (${requiredVars.length}):\n${requiredVars.map(([name]) => `  - ${name}`).join('\n')}\n\n`;
  }

  if (optionalVars.length > 0) {
    configMessage += `Optional (${optionalVars.length}):\n${optionalVars.map(([name]) => `  - ${name}`).join('\n')}\n\n`;
  }

  configMessage += `Tip: Press Ctrl+C at any time to cancel.`;

  clack.note(configMessage, 'Configuration Needed');

  const spinner = clack.spinner();
  let configuredCount = existingConfigured.length;
  let newlyConfigured = 0;
  const sessionConfigured = new Set<string>(); // Track variables configured in this session

  // Configure each missing variable
  for (let i = 0; i < missingVars.length; i++) {
    const [varName, config] = missingVars[i];

    // Add visual separation between variables
    if (i > 0) {
      console.log(''); // Add spacing between prompts
    }

    const isRequired = config.required !== false;
    const statusText = isRequired ? 'Required' : 'Optional';

    clack.log.info(`[${i + 1}/${missingVars.length}] ${varName} (${statusText})`);

    try {
      const value = await promptForEnvVar(varName, config);

      if (value) {
        spinner.start(`Saving ${varName} to .env file...`);
        await updateEnvFile(cwd, varName, value);
        spinner.stop(`${varName} configured successfully`);
        newlyConfigured++;
        configuredCount++;
        sessionConfigured.add(varName); // Track this variable as configured
      } else {
        const isRequired = config.required !== false;
        if (isRequired) {
          clack.log.warn(`Skipped required variable ${varName} - plugin may not work correctly`);
        } else {
          clack.log.info(`Skipped optional variable ${varName}`);
        }
      }
    } catch (error) {
      spinner.stop();
      clack.log.error(
        `Failed to configure ${varName}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // Final status with actionable next steps
  const requiredConfigured = Object.entries(envRequirements)
    .filter(([, config]) => config.required !== false)
    .filter(
      ([name]) => (existingVars[name] && existingVars[name] !== '') || sessionConfigured.has(name)
    ).length;

  const totalRequired = Object.entries(envRequirements).filter(
    ([, config]) => config.required !== false
  ).length;

  if (configuredCount === totalVars) {
    clack.outro(
      `Perfect! All ${totalVars} environment variables are configured.\n\n` +
        `Your ${packageName} plugin is ready to use!\n\n` +
        `Next steps:\n` +
        `- Restart your application to load the new environment variables\n` +
        `- Check your .env file if you need to modify any values later`
    );
  } else if (newlyConfigured > 0) {
    let message = `Successfully configured ${newlyConfigured} new environment variables!\n\n`;
    message += `Status: ${configuredCount}/${totalVars} total variables configured\n`;

    if (requiredConfigured === totalRequired) {
      message += `All required variables are set - your plugin should work!\n\n`;
    } else {
      message += `${totalRequired - requiredConfigured} required variables still missing\n\n`;
    }

    message += `Next steps:\n`;
    message += `- Restart your application to load new environment variables\n`;
    if (totalVars - configuredCount > 0) {
      message += `- Configure remaining ${totalVars - configuredCount} variables in your .env file if needed\n`;
    }
    message += `- Check the plugin documentation for additional setup steps`;

    clack.outro(message);
  } else {
    clack.outro(
      `No new variables were configured.\n\n` +
        `To set up this plugin, add these variables to your .env file:\n\n` +
        missingVars
          .map(([name, config]) => {
            const required = config.required !== false ? ' (Required)' : ' (Optional)';
            return `${name}=your_value_here${required}`;
          })
          .join('\n') +
        `\n\nRestart your application after adding the variables.`
    );
  }
};

import { logger } from '@elizaos/core';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as clack from '@clack/prompts';
import { EnvVarConfig } from '../types';

/**
 * Attempts to find the package.json of an installed plugin and extract environment variable requirements
 * from its agentConfig.pluginParameters
 */
export const extractPluginEnvRequirements = async (
  packageName: string,
  cwd: string
): Promise<Record<string, EnvVarConfig>> => {
  try {
    // Try to find the plugin's package.json in node_modules
    const nodeModulesPath = path.join(cwd, 'node_modules', packageName, 'package.json');

    if (!existsSync(nodeModulesPath)) {
      logger.debug(`Plugin package.json not found at: ${nodeModulesPath}`);
      return {};
    }

    const packageJsonContent = readFileSync(nodeModulesPath, 'utf-8');
    const packageJson = JSON.parse(packageJsonContent);

    // Extract environment variables from agentConfig.pluginParameters
    const agentConfig = packageJson.agentConfig;
    if (!agentConfig || !agentConfig.pluginParameters) {
      logger.debug(`No agentConfig.pluginParameters found in ${packageName}`);
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
export const readEnvFile = (cwd: string): string => {
  const envPath = path.join(cwd, '.env');
  try {
    return readFileSync(envPath, 'utf-8');
  } catch (error) {
    // File doesn't exist, return empty string
    return '';
  }
};

/**
 * Writes content to the .env file
 */
export const writeEnvFile = (cwd: string, content: string): void => {
  const envPath = path.join(cwd, '.env');
  writeFileSync(envPath, content, 'utf-8');
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
    description = 'No description available',
    default: explicitDefault,
    sensitive = false,
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

  // Create a more informative message with better formatting
  const message = defaultValue ? `Enter ${varName} (default: ${defaultValue})` : `Enter ${varName}`;
  const placeholder = isSecret ? 'Your secret key/token...' : defaultValue || 'Enter value...';

  // Show additional context for the environment variable with better formatting
  if (description && description !== 'No description available') {
    clack.note(`${description}`, `${varName} Info`);
  }

  const promptFn = isSecret ? clack.password : clack.text;

  const promptConfig: any = {
    message,
    placeholder,
    validate: (input: string) => {
      // Allow empty input if there's a default value
      if ((!input || input.trim() === '') && !defaultValue) {
        return 'This field cannot be empty. Press Ctrl+C to cancel.';
      }

      // Basic validation for common patterns
      if (varName.includes('URL') || varName.includes('ENDPOINT')) {
        try {
          new URL(input.trim());
        } catch {
          return 'Please enter a valid URL (e.g., https://api.example.com)';
        }
      }

      if (varName.includes('API_KEY') && input.trim().length < 5) {
        return 'API key seems too short. Please verify you entered the complete key.';
      }

      return undefined;
    },
  };

  // Add default value if available (only for non-secret fields)
  if (defaultValue && !isSecret) {
    promptConfig.initialValue = defaultValue;
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
export const updateEnvFile = (cwd: string, varName: string, value: string): void => {
  const envContent = readEnvFile(cwd);
  const lines = envContent.split('\n');

  // Check if the variable already exists
  const existingLineIndex = lines.findIndex((line) => line.startsWith(`${varName}=`));

  if (existingLineIndex >= 0) {
    // Update existing line
    lines[existingLineIndex] = `${varName}=${value}`;
  } else {
    // Add new line
    if (envContent && !envContent.endsWith('\n')) {
      lines.push(''); // Add empty line if file doesn't end with newline
    }
    lines.push(`${varName}=${value}`);
  }

  writeEnvFile(cwd, lines.join('\n'));
};

/**
 * Prompts for environment variables based on the plugin's agentConfig.pluginParameters
 * and writes them to the .env file
 */
export const promptForPluginEnvVars = async (packageName: string, cwd: string): Promise<void> => {
  const envRequirements = await extractPluginEnvRequirements(packageName, cwd);

  if (Object.keys(envRequirements).length === 0) {
    logger.debug(`No environment variables required for ${packageName}`);
    clack.log.success(`No environment variables required for ${packageName}`);
    return;
  }

  // Ensure all previous logs are complete before starting interactive prompts
  await new Promise((resolve) => setTimeout(resolve, 100));

  clack.intro(`Setting up ${packageName} Plugin`);

  // Read current .env file to check for existing values
  const envContent = readEnvFile(cwd);
  const existingVars: Record<string, string> = {};

  envContent.split('\n').forEach((line) => {
    const match = line.match(/^([^=]+)=(.*)$/);
    if (match) {
      existingVars[match[1]] = match[2];
    }
  });

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
        updateEnvFile(cwd, varName, value);
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

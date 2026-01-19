import colors from 'yoctocolors';
import { existsSync } from 'node:fs';
import path from 'node:path';
import ora from 'ora';
import { writeEnvFile, parseEnvFile } from '../../env/utils/file-operations';
import type { LoginOptions, SessionStatusResponse } from '../types';
import { generateSessionId, openBrowser, pollAuthStatus } from '../utils';

const ELIZAOS_API_KEY_ENV = 'ELIZAOS_API_KEY';

/**
 * Validates an elizaOS Cloud API key format
 * @param key The API key to validate
 * @returns True if the key appears valid (starts with 'eliza_' and has sufficient length)
 */
function isValidElizaCloudKey(key: string): boolean {
  if (!key || typeof key !== 'string') return false;
  // elizaOS Cloud keys start with 'eliza_' and should have reasonable length
  return key.startsWith('eliza_') && key.length > 10;
}

/**
 * Handle the login command
 * Orchestrates the complete authentication flow
 */
export async function handleLogin(options: LoginOptions): Promise<void> {
  console.log(colors.bold('\n🔐 elizaOS Cloud Authentication\n'));

  // Ensure cloud URL doesn't have trailing slash
  const cloudUrl = options.cloudUrl.replace(/\/$/, '');

  try {
    // Step 1: Generate unique session ID
    const sessionId = generateSessionId();
    console.log(colors.dim(`Session ID: ${sessionId}\n`));

    // Step 2: Create session on cloud
    const createSpinner = ora('Initializing authentication session...').start();

    try {
      const createResponse = await fetch(`${cloudUrl}/api/auth/cli-session`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ sessionId }),
      });

      if (!createResponse.ok) {
        createSpinner.fail('Failed to initialize session');
        const errorText = await createResponse.text();
        throw new Error(`Failed to create session: ${createResponse.status} ${errorText}`);
      }

      createSpinner.succeed('Session initialized');
    } catch (error) {
      createSpinner.fail('Failed to connect to cloud');
      throw new Error(
        `Could not connect to elizaOS Cloud at ${cloudUrl}. Please check the URL and try again.`
      );
    }

    // Step 3: Create auth URL
    const authUrl = `${cloudUrl}/auth/cli-login?session=${sessionId}`;

    // Step 4: Open browser if enabled
    if (options.browser) {
      console.log(colors.cyan('Opening browser for authentication...\n'));
      const browserOpened = await openBrowser(authUrl);

      if (!browserOpened) {
        console.log(colors.yellow('⚠️  Could not automatically open browser.\n'));
        displayManualInstructions(authUrl);
      } else {
        console.log(colors.green('✓ Browser opened successfully\n'));
        displayManualInstructions(authUrl);
      }
    } else {
      displayManualInstructions(authUrl);
    }

    // Step 5: Poll for authentication status
    const timeoutSeconds = Number.parseInt(options.timeout, 10);

    // Validate timeout value
    if (isNaN(timeoutSeconds) || timeoutSeconds <= 0) {
      console.error(
        colors.red(
          `\n❌ Invalid timeout value: "${options.timeout}". Please provide a positive number.\n`
        )
      );
      console.log(colors.dim('Example: elizaos login --timeout 600\n'));
      process.exit(1);
    }

    const spinner = ora({
      text: 'Waiting for authentication...',
      color: 'cyan',
    }).start();

    let authResult: SessionStatusResponse | null = null;

    try {
      authResult = await pollAuthStatus(cloudUrl, sessionId, timeoutSeconds);
    } catch (error) {
      spinner.fail('Authentication failed');
      throw error;
    }

    if (!authResult || authResult.status !== 'authenticated') {
      spinner.fail('Authentication timed out or failed');
      console.log(
        colors.yellow(
          '\n⏱  Authentication timed out. Please try again with a longer timeout using --timeout flag.\n'
        )
      );
      process.exit(1);
    }

    if (!authResult.apiKey) {
      spinner.fail('No API key received');
      throw new Error('Failed to receive API key from authentication');
    }

    // Validate API key format
    if (!isValidElizaCloudKey(authResult.apiKey)) {
      spinner.fail('Invalid API key format received');
      console.log(
        colors.yellow(
          '\n⚠️  The API key received does not match the expected format (eliza_xxxxx).'
        )
      );
      console.log(colors.yellow('Please try again or contact support.\n'));
      throw new Error('Invalid API key format: expected eliza_xxxxx');
    }

    spinner.succeed('Authentication successful!');

    // Step 6: Write API key to .env file
    await writeApiKeyToEnv(authResult.apiKey, options.envFilePath);

    // Step 7: Display success message
    displaySuccessMessage(authResult);
  } catch (error) {
    if (error instanceof Error) {
      console.error(colors.red(`\n❌ Error: ${error.message}\n`));
    }
    throw error;
  }
}

/**
 * Display manual instructions for authentication
 */
function displayManualInstructions(authUrl: string): void {
  console.log(colors.bold('Please complete authentication in your browser:'));
  console.log(colors.blue(`\n  ${authUrl}\n`));
}

/**
 * Write API key to project .env file
 * @param apiKey The API key to write
 * @param envFilePath Optional path to the .env file (defaults to current directory)
 */
async function writeApiKeyToEnv(apiKey: string, envFilePath?: string): Promise<void> {
  const spinner = ora('Saving API key to .env file...').start();

  try {
    // Use provided path or default to .env in current directory
    const envPath = envFilePath || path.join(process.cwd(), '.env');
    let envVars: Record<string, string> = {};

    // Read existing .env file if it exists
    if (existsSync(envPath)) {
      try {
        envVars = await parseEnvFile(envPath);
      } catch (error) {
        spinner.warn('.env file exists but could not be read, creating new one');
        envVars = {};
      }
    }

    // Update or add API key
    envVars[ELIZAOS_API_KEY_ENV] = apiKey;

    // Write back to .env file
    await writeEnvFile(envPath, envVars);

    spinner.succeed(`API key saved to ${colors.cyan('.env')}`);
  } catch (error) {
    spinner.fail('Failed to save API key to .env file');
    console.log(colors.yellow('\n⚠️  Please manually add this key to your .env file:'));
    console.log(colors.dim(`${ELIZAOS_API_KEY_ENV}=${apiKey}\n`));
    throw error;
  }
}

/**
 * Display success message with API key details
 */
function displaySuccessMessage(authResult: SessionStatusResponse): void {
  console.log(colors.green('\n✨ You are now authenticated with elizaOS Cloud!\n'));
  console.log(colors.bold('API Key Details:'));
  console.log(colors.dim(`  Prefix: ${authResult.keyPrefix}`));

  if (authResult.expiresAt) {
    const expiryDate = new Date(authResult.expiresAt);
    console.log(colors.dim(`  Expires: ${expiryDate.toLocaleDateString()}`));
  } else {
    console.log(colors.dim(`  Expires: Never`));
  }

  console.log(colors.bold('\n📝 Next Steps:'));
  console.log('  • Your API key has been saved to .env');
  console.log('  • You can now use elizaOS Cloud features');
  console.log('  • View your usage at the cloud dashboard\n');
}

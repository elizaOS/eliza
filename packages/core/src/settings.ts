import { config } from "dotenv";
import fs from "fs";
import path from "path";
import * as dotenv from 'dotenv';
import elizaLogger from "./logger.ts";
import {
    SecretsManagerClient,
    GetSecretValueCommand
} from "@aws-sdk/client-secrets-manager";

interface SecretConfig {
    secretNames: string[];
    region: string;
    roleArn?: string;
}

interface Settings {
    [key: string]: string | undefined;
}

let environmentSettings: Settings = {};

/**
 * Determines if code is running in a browser environment
 */
const isBrowser = (): boolean => {
    return typeof window !== "undefined" && typeof window.document !== "undefined";
};

/**
 * Recursively searches for a .env file starting from the current directory
 */
export function findNearestEnvFile(startDir = process.cwd()) {
    if (isBrowser()) return null;

    elizaLogger.info('Starting search for .env file from directory:', startDir);
    let currentDir = startDir;

    while (currentDir !== path.parse(currentDir).root) {
        const envPath = path.join(currentDir, ".env");
        elizaLogger.info('Checking for .env file at:', envPath);

        if (fs.existsSync(envPath)) {
            elizaLogger.info('Found .env file at:', envPath);
            return envPath;
        }

        currentDir = path.dirname(currentDir);
        elizaLogger.info('Moving up to directory:', currentDir);
    }

    const rootEnvPath = path.join(path.parse(currentDir).root, ".env");
    elizaLogger.info('Checking root directory for .env file:', rootEnvPath);
    return fs.existsSync(rootEnvPath) ? rootEnvPath : null;
}

/**
 * Fetches secrets from AWS Secrets Manager
 */
async function getSecretsManagerValues(secretConfig: SecretConfig): Promise<Record<string, string>> {
    elizaLogger.info('Starting to fetch secrets with config:', secretConfig);
    const { secretNames, region } = secretConfig;

    const client = new SecretsManagerClient({ region });
    const secrets: Record<string, string> = {};

    elizaLogger.info('Starting to fetch secrets for:', secretNames);
    const secretPromises = secretNames.map(async (secretName) => {
        elizaLogger.info('Fetching secret:', secretName);
        try {
            const response = await client.send(
                new GetSecretValueCommand({ SecretId: secretName })
            );
            elizaLogger.info(`Received response for secret ${secretName}`);

            if (response.SecretString) {
                try {
                    elizaLogger.info(`Attempting to parse secret ${secretName} as JSON`);
                    const secretJson = JSON.parse(response.SecretString);
                    elizaLogger.info(`Successfully parsed secret ${secretName}, found keys:`, Object.keys(secretJson));
                    Object.entries(secretJson).forEach(([key, value]) => {
                        secrets[key] = value as string;
                    });
                } catch (parseError) {
                    elizaLogger.info(`Secret ${secretName} is not JSON, storing as plain string`);
                    secrets[secretName] = response.SecretString;
                }
            }
        } catch (error) {
            elizaLogger.error(`Failed to fetch secret ${secretName}:`, error);
            throw error;
        }
    });

    await Promise.all(secretPromises);
    return secrets;
}

/**
 * Configures environment settings for browser usage
 */
export function configureSettings(settings: Settings) {
    environmentSettings = { ...settings };
}

/**
 * Loads environment variables from .env and AWS Secrets Manager
 */
export async function loadEnvConfig(): Promise<Settings> {
    // For browser environments, return the configured settings
    if (isBrowser()) {
        return environmentSettings;
    }

    elizaLogger.info('Starting loadEnvConfig');
    const envPath = findNearestEnvFile();

    if (!envPath) {
        elizaLogger.error('No .env file found in directory hierarchy');
        throw new Error("No .env file found in current or parent directories.");
    }

    elizaLogger.info('Loading .env file from:', envPath);
    const result = config({ path: envPath });

    if (result.error) {
        elizaLogger.error('Error loading .env file:', result.error);
        throw new Error(`Error loading .env file: ${result.error}`);
    }

    // Read directly from the .env file
    const envConfig = dotenv.parse(fs.readFileSync(envPath));
    elizaLogger.info('Direct .env file contents:', envConfig);

    // Create secretConfig using the direct .env contents
    const secretConfig = {
        secretNames: envConfig.SECRET_NAMES?.split(',') || [],
        region: envConfig.AWS_REGION || 'us-east-1',
        roleArn: envConfig.AWS_ROLE_ARN?.trim()
    };

    // Load secrets from AWS if configured
    if (secretConfig.secretNames.length > 0) {
        try {
            const secrets = await getSecretsManagerValues(secretConfig);
            elizaLogger.info('Successfully fetched secrets, found keys:', Object.keys(secrets));

            Object.entries(secrets).forEach(([key, value]) => {
                process.env[key] = value;
            });
            elizaLogger.info(`Loaded all secrets from AWS Secrets Manager: ${secretConfig.secretNames.join(', ')}`);
        } catch (error) {
            elizaLogger.error('Failed to load secrets from AWS Secrets Manager:', error);
            throw new Error(`Failed to load secrets from AWS Secrets Manager: ${error}`);
        }
    } else {
        elizaLogger.info('No secret names provided, skipping AWS Secrets Manager');
    }

    // Log embedding settings
    elizaLogger.info("Loading embedding settings:", {
        USE_OPENAI_EMBEDDING: process.env.USE_OPENAI_EMBEDDING,
        USE_OLLAMA_EMBEDDING: process.env.USE_OLLAMA_EMBEDDING,
        OLLAMA_EMBEDDING_MODEL: process.env.OLLAMA_EMBEDDING_MODEL || "mxbai-embed-large",
    });

    // Log character settings
    elizaLogger.info("Loading character settings:", {
        CHARACTER_PATH: process.env.CHARACTER_PATH,
        ARGV: process.argv,
        CHARACTER_ARG: process.argv.find((arg) => arg.startsWith("--character=")),
        CWD: process.cwd(),
    });

    return process.env as Settings;
}

/**
 * Gets a specific environment variable
 */
export function getEnvVariable(key: string, defaultValue?: string): string | undefined {
    if (isBrowser()) {
        return environmentSettings[key] || defaultValue;
    }
    return process.env[key] || defaultValue;
}

/**
 * Checks if a specific environment variable exists
 */
export function hasEnvVariable(key: string): boolean {
    if (isBrowser()) {
        return key in environmentSettings;
    }
    return key in process.env;
}

// Initialize settings based on environment
export const settings = isBrowser() ? environmentSettings : await loadEnvConfig();

elizaLogger.info("Parsed settings:", {
    USE_OPENAI_EMBEDDING: settings.USE_OPENAI_EMBEDDING,
    USE_OPENAI_EMBEDDING_TYPE: typeof settings.USE_OPENAI_EMBEDDING,
    USE_OLLAMA_EMBEDDING: settings.USE_OLLAMA_EMBEDDING,
    USE_OLLAMA_EMBEDDING_TYPE: typeof settings.USE_OLLAMA_EMBEDDING,
    OLLAMA_EMBEDDING_MODEL: settings.OLLAMA_EMBEDDING_MODEL || "mxbai-embed-large",
});

export default settings;
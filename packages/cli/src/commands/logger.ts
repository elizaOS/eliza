import { Command } from 'commander';
import prompts from 'prompts';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { logger } from '@elizaos/core';
import { getElizaDirectories } from '@/src/utils/get-config';
import { LoggerConfig } from '@/src/types/logger';

const DEFAULT_CONFIG: LoggerConfig = {
  level: 'info',
  transport: 'console',
  jsonFormat: false,
};

async function ensureConfigDir(): Promise<string> {
  const dirs = await getElizaDirectories();
  if (!existsSync(dirs.elizaDir)) {
    mkdirSync(dirs.elizaDir, { recursive: true });
  }
  return dirs.elizaDir;
}

async function loadConfig(): Promise<LoggerConfig> {
  try {
    const configDir = await ensureConfigDir();
    const configFile = path.join(configDir, 'logger.config.json');
    if (existsSync(configFile)) {
      const content = readFileSync(configFile, 'utf-8');
      const config = JSON.parse(content);
      return { ...DEFAULT_CONFIG, ...config };
    }
  } catch (error) {
    logger.warn('Failed to load logger config, using defaults:', error);
  }
  return { ...DEFAULT_CONFIG };
}

async function saveConfig(config: LoggerConfig): Promise<void> {
  try {
    const configDir = await ensureConfigDir();
    const configFile = path.join(configDir, 'logger.config.json');
    writeFileSync(configFile, JSON.stringify(config, null, 2));
    logger.success('Logger configuration saved!');
  } catch (error) {
    logger.error('Failed to save logger config:', error);
  }
}

function displayConfig(config: LoggerConfig): void {
  console.log('\n📋 Current Logger Configuration:');
  console.log('================================');
  console.log(`Log Level: ${config.level}`);
  console.log(`Transport: ${config.transport}`);
  console.log(`JSON Format: ${config.jsonFormat ? 'Yes' : 'No'}`);
  
  if (config.file) {
    console.log(`File Path: ${config.file}`);
  }
  console.log('================================\n');
}

async function interactiveConfiguration(): Promise<void> {
  const currentConfig = await loadConfig();
  
  const response = await prompts({
    type: 'select',
    name: 'action',
    message: 'What would you like to do?',
    choices: [
      { title: 'Configure basic settings', value: 'basic' },
      { title: 'Show current configuration', value: 'show' },
      { title: 'Reset to defaults', value: 'reset' },
    ],
  });

  if (!response.action) {
    console.log('Configuration cancelled.');
    return;
  }

  switch (response.action) {
    case 'basic':
      await configureBasicSettings(currentConfig);
      break;
    case 'show':
      displayConfig(currentConfig);
      break;
    case 'reset':
      await saveConfig(DEFAULT_CONFIG);
      logger.success('Configuration reset to defaults');
      displayConfig(DEFAULT_CONFIG);
      break;
  }
}

async function configureBasicSettings(currentConfig: LoggerConfig): Promise<void> {
  const response = await prompts([
    {
      type: 'select',
      name: 'level',
      message: 'Select log level:',
      choices: [
        { title: 'trace (most verbose)', value: 'trace' },
        { title: 'debug', value: 'debug' },
        { title: 'info (recommended)', value: 'info' },
        { title: 'warn', value: 'warn' },
        { title: 'error', value: 'error' },
        { title: 'fatal (least verbose)', value: 'fatal' },
      ],
      initial: ['trace', 'debug', 'info', 'warn', 'error', 'fatal'].indexOf(currentConfig.level),
    },
    {
      type: 'select',
      name: 'transport',
      message: 'Select output destination:',
      choices: [
        { title: 'Console only', value: 'console' },
        { title: 'Console + File (hybrid)', value: 'file' },
      ],
    },
    {
      type: 'toggle',
      name: 'jsonFormat',
      message: 'Use JSON format?',
      initial: currentConfig.jsonFormat,
      active: 'yes',
      inactive: 'no',
    },
  ]);

  if (Object.keys(response).length === 0) {
    console.log('Configuration cancelled.');
    return;
  }

  const newConfig: LoggerConfig = {
    ...currentConfig,
    ...response,
  };

  // Handle file transport
  if (response.transport === 'file') {
    const dirs = await getElizaDirectories();
    const defaultLogFile = path.join(dirs.elizaDir, 'logs', 'eliza.log');
    
    const fileResponse = await prompts({
      type: 'text',
      name: 'file',
      message: 'Enter log file path:',
      initial: currentConfig.file || defaultLogFile,
    });
    
    if (fileResponse.file) {
      newConfig.file = fileResponse.file;
    }
  }

  await saveConfig(newConfig);
  displayConfig(newConfig);
}

export const loggerCommand = new Command()
  .name('logger')
  .description('Configure logging settings interactively')
  .addHelpText('after', `
Examples:
  elizaos logger                    # Interactive configuration menu
  
Interactive Options:
  • Configure basic settings        Set log level, transport, and format
  • Show current configuration      Display current logger settings  
  • Reset to defaults              Reset to default configuration

Configuration is saved to .eliza/logger.config.json in your project directory.
`)
  .action(async () => {
    try {
      await interactiveConfiguration();
    } catch (error) {
      logger.error('Failed to configure logger:', error);
      process.exit(1);
    }
  });

export default loggerCommand; 
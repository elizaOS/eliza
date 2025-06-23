import { displayBanner, handleError } from '@/src/utils';
import { validatePort } from '@/src/utils/port-validation';
import { loadCharacterTryPath } from '@elizaos/server';
import { loadProject } from '@/src/project';
import { logger, type Character, type ProjectAgent } from '@elizaos/core';
import { Command } from 'commander';
import { startAgents } from './actions/server-start';
import { StartOptions } from './types';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadEnvConfig } from './utils/config-utils';
import { getElizaDirectories } from '@/src/utils/get-config';
import { LoggerConfig } from '@/src/types/logger';

function setupFileLogging(logFile: string, jsonFormat?: boolean): void {
  try {
    const logDir = path.dirname(logFile);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    const fileStream = fs.createWriteStream(logFile, { flags: 'a' });
    
    const currentDestination = (logger as any)[Symbol.for('pino-destination')];

    if (currentDestination && typeof currentDestination.write === 'function') {
      const originalWrite = currentDestination.write.bind(currentDestination);

      currentDestination.write = function(chunk: any) {
        if (jsonFormat) {
          process.stdout.write(chunk);
        } else {
          originalWrite(chunk);
        }

        try {
          if (typeof chunk === 'string') {
            if (jsonFormat) {
              fileStream.write(chunk);
            } else {
              const logEntry = JSON.parse(chunk);
              const timestamp = new Date(logEntry.time).toISOString();
              
              let level = 'info';
              if (typeof logEntry.level === 'number') {
                const levelMap: Record<number, string> = {
                  10: 'trace', 20: 'debug', 30: 'info', 
                  40: 'warn', 50: 'error', 60: 'fatal'
                };
                level = levelMap[logEntry.level] || 'info';
              }
              
              const message = logEntry.msg || '';
              const cleanLogLine = `[${timestamp}] ${level.toUpperCase()}: ${message}\n`;
              fileStream.write(cleanLogLine);
            }
          }
        } catch (e) {
          fileStream.write(chunk);
        }
      };

      logger.info(`File logging enabled: ${logFile} (format: ${jsonFormat ? 'JSON' : 'readable'})`);

      const cleanup = () => {
        try {
          fileStream.end();
        } catch (e) {
        }
      };

      process.on('exit', cleanup);
      process.on('SIGINT', () => {
        cleanup();
        process.exit(0);
      });
      process.on('SIGTERM', cleanup);

    } else {
      logger.warn('Could not enhance logger with file output - destination not accessible');
    }

  } catch (error) {
    logger.error('Failed to setup file logging:', error);
  }
}

async function loadLoggerConfig(): Promise<LoggerConfig | null> {
  try {
    const dirs = await getElizaDirectories();
    const configPath = path.join(dirs.elizaDir, 'logger.config.json');
    if (fs.existsSync(configPath)) {
      const configData = fs.readFileSync(configPath, 'utf-8');
      return JSON.parse(configData);
    }
  } catch (error) {
    logger.debug('Failed to load logger config:', error);
  }
  return null;
}

async function applyLoggerOptions(options: StartOptions): Promise<void> {
  const config = await loadLoggerConfig();
  
  // Default log file path in .eliza/logs if not specified
  const dirs = await getElizaDirectories();
  const defaultLogFile = path.join(dirs.elizaDir, 'logs', 'eliza.log');
  
  // Priority order: CLI > ENV > Config file > Defaults
  const finalConfig = {
    level: options.logLevel || process.env.LOG_LEVEL || config?.level || 'info',
    transport: options.logTransport || process.env.LOG_TRANSPORT || config?.transport || 'console',
    file: options.logFile || process.env.LOG_FILE || config?.file || defaultLogFile,
    jsonFormat: options.logJson !== undefined ? options.logJson : 
                (process.env.LOG_JSON_FORMAT !== undefined ? process.env.LOG_JSON_FORMAT === 'true' : 
                 config?.jsonFormat !== undefined ? config.jsonFormat : false)
  };

  if (finalConfig.transport && !['console', 'file'].includes(finalConfig.transport)) {
    logger.warn(`Unsupported transport '${finalConfig.transport}'. Using console transport.`);
    finalConfig.transport = 'console';
  }

  if (finalConfig.level) {
    process.env.LOG_LEVEL = finalConfig.level.toLowerCase();
  }
  
  if (finalConfig.jsonFormat !== undefined) {
    process.env.LOG_JSON_FORMAT = finalConfig.jsonFormat ? 'true' : 'false';
  }
  
  // Set transport type
  process.env.LOG_TRANSPORT = finalConfig.transport;
  
  // Note: Logger reconfiguration would happen here in a complete implementation
  
  // Handle file transport at CLI level (after core logger is configured)
  if (finalConfig.transport === 'file' && finalConfig.file) {
    setupFileLogging(finalConfig.file, finalConfig.jsonFormat);
  }
  
  // Log final configuration with source indication
  const sources = [];
  if (options.logLevel) sources.push('CLI');
  else if (process.env.LOG_LEVEL) sources.push('ENV');
  else if (config?.level) sources.push('config');
  else sources.push('default');
  
  logger.info(`Logger configured: level=${finalConfig.level} (from ${sources[0]}), transport=${finalConfig.transport}${finalConfig.file ? `, file=${finalConfig.file}` : ''}`);
}

export const start = new Command()
  .name('start')
  .description('Start the Eliza agent server')
  .option('-c, --configure', 'Reconfigure services and AI models')
  .option('-p, --port <port>', 'Port to listen on', validatePort)
  .option('--character <paths...>', 'Character file(s) to use')
  .option('--log-level <level>', 'Set log level (trace, debug, info, warn, error, fatal)')
  .option('--log-transport <transport>', 'Set log transport (console, file)')
  .option('--log-file <path>', 'Set log file path (for file transport)')
  .option('--log-json', 'Enable JSON format logging')
  .option('--no-log-pretty', 'Disable pretty printing')
  .hook('preAction', async (_thisCommand: any, actionCommand: any) => {
    const options = actionCommand.opts() as StartOptions;
    await applyLoggerOptions(options);
    await displayBanner();
  })
  .action(async (options: StartOptions & { character?: string[] }) => {
    try {
      
      // Load env config first before any character loading
      await loadEnvConfig();

      let characters: Character[] = [];
      let projectAgents: ProjectAgent[] = [];

      if (options.character && options.character.length > 0) {
        // Validate and load characters from provided paths
        for (const charPath of options.character) {
          const resolvedPath = path.resolve(charPath);

          if (!fs.existsSync(resolvedPath)) {
            logger.error(`Character file not found: ${resolvedPath}`);
            throw new Error(`Character file not found: ${resolvedPath}`);
          }

          try {
            const character = await loadCharacterTryPath(resolvedPath);
            if (character) {
              characters.push(character);
              logger.info(`Successfully loaded character: ${character.name}`);
            } else {
              logger.error(
                `Failed to load character from ${resolvedPath}: Invalid or empty character file`
              );
              throw new Error(`Invalid character file: ${resolvedPath}`);
            }
          } catch (e) {
            logger.error(`Failed to load character from ${resolvedPath}:`, e);
            throw new Error(`Invalid character file: ${resolvedPath}`);
          }
        }
      } else {
        // Try to load project agents if no character files specified
        try {
          const cwd = process.cwd();
          const packageJsonPath = path.join(cwd, 'package.json');

          // Check if we're in a project directory
          if (fs.existsSync(packageJsonPath)) {
            logger.info('No character files specified, attempting to load project agents...');
            const project = await loadProject(cwd);

            if (project.agents && project.agents.length > 0) {
              logger.info(`Found ${project.agents.length} agent(s) in project configuration`);
              projectAgents = project.agents;

              // Log loaded agent names
              for (const agent of project.agents) {
                if (agent.character) {
                  logger.info(`Loaded character: ${agent.character.name}`);
                }
              }
            }
          }
        } catch (e) {
          logger.debug('Failed to load project agents, will use default character:', e);
        }
      }

      await startAgents({ ...options, characters, projectAgents });
    } catch (e: any) {
      handleError(e);
      process.exit(1);
    }
  });

// Re-export for backward compatibility
export * from './actions/agent-start';
export * from './actions/server-start';
export * from './types';
export * from './utils/config-utils';
export * from './utils/dependency-resolver';
export * from './utils/plugin-utils';

import dotenv from "dotenv";
dotenv.config({ path: "../../.env" });

import {
  AgentRuntime,
  logger,
  parseBooleanFromText,
  settings,
  stringToUuid,
  type Character,
  type IAgentRuntime,
  type IDatabaseAdapter,
  type Plugin
} from "@elizaos/core";
import { createDatabaseAdapter } from "@elizaos/plugin-sql";
import * as fs from "node:fs";
import net from "node:net";
import * as path from "node:path";
import { character as defaultCharacter } from "../characters/eliza";
import { AgentServer } from "../server/index.ts";
import {
  hasValidRemoteUrls,
  jsonToCharacter,
  loadCharacters,
  loadCharacterTryPath
} from "../server/loader.ts";

// Convert this into a command
import { Command } from "commander";

export const wait = (minTime = 1000, maxTime = 3000) => {
  const waitTime =
    Math.floor(Math.random() * (maxTime - minTime + 1)) + minTime;
  return new Promise((resolve) => setTimeout(resolve, waitTime));
};

async function startAgent(
  character: Character,
  server: AgentServer,
  init?: (runtime: IAgentRuntime) => void,
  plugins: Plugin[] = []
): Promise<IAgentRuntime> {
  let db: IDatabaseAdapter;
  try {
    character.id ??= stringToUuid(character.name);

    const runtime = new AgentRuntime({
      character,
      plugins
    });

    if (init) {
      await init(runtime);
    }

    // initialize database
    // find a db from the plugins
    db = await createDatabaseAdapter({
      dataDir: path.join(process.cwd(), "data"),
      postgresUrl: process.env.POSTGRES_URL,
    }, runtime.agentId);
    runtime.databaseAdapter = db;

    // Make sure character exists in database
    await runtime.databaseAdapter.ensureAgentExists(character);

    // start services/plugins/process knowledge    
    await runtime.initialize();

    // add to container
    server.registerAgent(runtime);
    
    // report to console
    logger.debug(`Started ${runtime.character.name} as ${runtime.agentId}`);

    return runtime;
  } catch (error) {
    logger.error(
      `Error starting agent for character ${character.name}:`,
      error
    );
    logger.error(error);
    if (db) {
      await db.close();
    }
    throw error;
  }
}

async function stopAgent(
  runtime: IAgentRuntime,
  server: AgentServer
) {
  await runtime.databaseAdapter.close();
  server.unregisterAgent(runtime.agentId);
}

const checkPortAvailable = (port: number): Promise<boolean> => {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        resolve(false);
      }
    });

    server.once("listening", () => {
      server.close();
      resolve(true);
    });

    server.listen(port);
  });
};

const startAgents = async () => {
  // Add debugging at the beginning 
  console.log("=== Starting ElizaOS Agents ===");
  console.log("Current directory:", process.cwd());
  
  const server = new AgentServer();
  
  // Assign the required functions first
  server.startAgent = async (character) => {
    logger.info(`Starting agent for character ${character.name}`);
    return startAgent(character, server);
  };
  server.stopAgent = (runtime: IAgentRuntime) => {
    stopAgent(runtime, server);
  }
  server.loadCharacterTryPath = loadCharacterTryPath;
  server.jsonToCharacter = jsonToCharacter;

  // (this is just to prevent squiggles)
  const args = {} as any

  let serverPort = Number.parseInt(settings.SERVER_PORT || "3000");
  const charactersArg = args.characters || args.character;
  
  // Add this before creating the AgentServer
  const dataDir = path.join(process.cwd(), "data");
  try {
    fs.accessSync(dataDir, fs.constants.W_OK);
    logger.debug(`Data directory ${dataDir} is writable`);
  } catch (error) {
    logger.error(`Data directory ${dataDir} is not writable:`, error);
    fs.mkdirSync(dataDir, { recursive: true });
    logger.info(`Created data directory ${dataDir}`);
  }

  // 1. Check if we're in a project with a package.json
  const packageJsonPath = path.join(process.cwd(), 'package.json');
  let isProject = false;
  let isPlugin = false;
  let pluginModule: Plugin | null = null;
  let projectPath = '';
  let projectModule: { default?: { agents: any[] } } | null = null;
  let useDefaultCharacter = false;

  try {
    if (fs.existsSync(packageJsonPath)) {
      // Read and parse package.json to check if it's a project or plugin
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
      
      // Check if this is a plugin
      isPlugin = false; // Reset to be sure
      const name = packageJson.name || '';
      const description = packageJson.description || '';
      
      // First check for exact match with plugin-starter
      if (name === '@elizaos/plugin-starter') {
        isPlugin = true;
        logger.info('Found @elizaos/plugin-starter package, loading as plugin');
      } 
      // Then check more general cases
      else if (
        (name.includes('plugin') || name.includes('adapter')) && 
        packageJson.dependencies && 
        packageJson.dependencies["@elizaos/core"]) {
        isPlugin = true;
        logger.info(`Found plugin package: ${name}`);
      }
      // Last resort check description
      else if (
        description.toLowerCase().includes('plugin') && 
        packageJson.dependencies && 
        packageJson.dependencies["@elizaos/core"]) {
        isPlugin = true;
        logger.info(`Found plugin from description: ${description}`);
      }
      
      if (!isPlugin) {
        isProject = true;
        logger.info('Package is not detected as a plugin, treating as project');
      } else {
        logger.info('Plugin detected - will load onto default character');
      }
      
      // 2. Read and parse package.json to get main entry point and check for build script
      const hasBuildScript = packageJson.scripts && packageJson.scripts.build;
      
      // Check if dist directory exists
      const distDir = path.join(process.cwd(), 'dist');
      const distExists = fs.existsSync(distDir);
      
      // If no build script or no dist directory exists
      if (!hasBuildScript && !distExists) {
        if (isPlugin) {
          logger.info('No build script and no dist directory found for plugin, building...');
          try {
            // Execute build command - use bun directly for plugins
            const { exec } = require('child_process');
            await new Promise<void>((resolve, reject) => {
              // Use bun build for plugins directly
              exec('bun run build', (error: Error | null) => {
                if (error) {
                  logger.error(`Error building plugin with bun: ${error.message}`);
                  resolve();
                  return;
                }
                logger.info('Plugin built successfully with bun');
                resolve();
              });
            });
            
            // After building, check if dist now exists
            if (!fs.existsSync(distDir)) {
              logger.warn('Dist directory still not found after build for plugin');
              // Don't change isPlugin to false here, just try to load from src directly
            }
          } catch (buildError) {
            logger.error(`Failed to build plugin: ${buildError}`);
            // Don't change isPlugin to false here, just try to load from src directly
          }
        } else {
          logger.info('No build script and no dist directory found, using default character');
          useDefaultCharacter = true;
        }
      }
      // If there's a build script but no dist, run the build
      else if (hasBuildScript && !distExists) {
        if (isPlugin) {
          logger.info('Build script found but no dist directory for plugin, running bun build...');
          try {
            // Execute build command - use bun directly for plugins
            const { exec } = require('child_process');
            await new Promise<void>((resolve, reject) => {
              // Use bun build for plugins directly
              exec('bun run build', (error: Error | null) => {
                if (error) {
                  logger.error(`Error building plugin with bun: ${error.message}`);
                  resolve();
                  return;
                }
                logger.info('Plugin built successfully with bun');
                resolve();
              });
            });
            
            // After building, check if dist now exists
            if (!fs.existsSync(distDir)) {
              logger.warn('Dist directory still not found after build for plugin');
              // Don't change isPlugin to false here, just try to load from src directly
            }
          } catch (buildError) {
            logger.error(`Failed to build plugin: ${buildError}`);
            // Don't change isPlugin to false here, just try to load from src directly
          }
        } else {
          logger.info('Build script found but no dist directory, running build...');
          try {
            // Execute build command
            const { exec } = require('child_process');
            await new Promise<void>((resolve, reject) => {
              exec('npm run build', (error: Error | null) => {
                if (error) {
                  logger.error(`Error building project: ${error.message}`);
                  useDefaultCharacter = true;
                  resolve();
                  return;
                }
                logger.info('Project built successfully');
                resolve();
              });
            });
            
            // After building, check if dist now exists
            if (!fs.existsSync(distDir)) {
              logger.warn('Dist directory still not found after build, using default character');
              useDefaultCharacter = true;
            }
          } catch (buildError) {
            logger.error(`Failed to build project: ${buildError}`);
            useDefaultCharacter = true;
          }
        }
      }
      
      // If we're not using the default character, try to import the project or plugin
      if (!useDefaultCharacter || isPlugin) {
        // Load the compiled project or plugin from package.json's 'main' path entry
        let mainEntry = packageJson.main;
        
        if (!mainEntry && isPlugin) {
          // If no main entry point but it's a plugin, try common plugin entry points
          const possibleEntryPoints = [
            'dist/index.js',
            'src/index.ts',
            'src/index.js',
            'index.js',
            'index.ts'
          ];
          
          for (const entry of possibleEntryPoints) {
            if (fs.existsSync(path.join(process.cwd(), entry))) {
              mainEntry = entry;
              logger.info(`No main entry in package.json, using ${entry}`);
              break;
            }
          }
        }
        
        if (mainEntry) {
          projectPath = path.resolve(process.cwd(), mainEntry);
          
          if (fs.existsSync(projectPath)) {
            if (isPlugin) {
              logger.info(`Loading plugin from ${projectPath}`);
              try {
                const pluginImport = await import(projectPath);
                pluginModule = pluginImport.default;
                
                if (!pluginModule) {
                  logger.error('Plugin module does not export a default export');
                  // Try to find any exported plugin object
                  for (const key in pluginImport) {
                    if (pluginImport[key] && 
                        typeof pluginImport[key] === 'object' && 
                        pluginImport[key].name && 
                        typeof pluginImport[key].init === 'function') {
                      pluginModule = pluginImport[key];
                      logger.info(`Found plugin export under key: ${key}`);
                      break;
                    }
                  }
                  
                  if (!pluginModule) {
                    logger.error('Could not find any valid plugin export');
                    isPlugin = false;
                    useDefaultCharacter = true;
                  }
                } else {
                  logger.info(`Successfully loaded plugin: ${pluginModule.name || 'unnamed plugin'}`);
                }
              } catch (importError) {
                logger.error(`Error importing plugin module: ${importError}`);
                isPlugin = false;
                useDefaultCharacter = true;
              }
            } else {
              logger.info(`Loading project from ${projectPath}`);
              try {
                projectModule = await import(projectPath);
              } catch (importError) {
                logger.error(`Error importing project module: ${importError}`);
                useDefaultCharacter = true;
              }
            }
          } else {
            if (isPlugin) {
              logger.error(`Plugin entry point ${projectPath} does not exist`);
              // Try to find the plugin in src directory
              const srcPath = path.join(process.cwd(), 'src', 'index.ts');
              if (fs.existsSync(srcPath)) {
                logger.info(`Trying to load plugin from src: ${srcPath}`);
                try {
                  // For TypeScript files, we need to transpile or use ts-node/esm
                  const { exec } = require('child_process');
                  exec('npx tsc', async (error: Error | null) => {
                    if (!error) {
                      try {
                        const srcModule = await import(path.join(process.cwd(), 'dist', 'index.js'));
                        pluginModule = srcModule.default;
                        logger.info(`Successfully loaded plugin from transpiled source`);
                      } catch (e) {
                        logger.error(`Failed to load transpiled plugin: ${e}`);
                      }
                    }
                  });
                } catch (e) {
                  logger.error(`Failed to transpile plugin: ${e}`);
                }
              } else {
                isPlugin = false;
                useDefaultCharacter = true;
              }
            } else {
              logger.error(`Main entry point ${projectPath} does not exist`);
              useDefaultCharacter = true;
            }
          }
        } else {
          if (isPlugin) {
            logger.error('No main entry point found for plugin');
            // Try to load the plugin directly from source
            const srcPath = path.join(process.cwd(), 'src', 'index.ts');
            if (fs.existsSync(srcPath)) {
              // Similar approach as above, try to compile and load
              // This is a simplified approach - might not work for all setups
              isPlugin = false;
              useDefaultCharacter = true;
            } else {
              isPlugin = false;
              useDefaultCharacter = true;
            }
          } else {
            logger.error('No "main" field found in package.json');
            useDefaultCharacter = true;
          }
        }
      }
    } else {
      logger.info('No package.json found, using default character');
      useDefaultCharacter = true;
    }
  } catch (error) {
    logger.error(`Error checking for project: ${error}`);
    useDefaultCharacter = true;
  }

  // Start agents based on project, plugin, or default configuration
  try {
    if (isPlugin && pluginModule) {
      // Load the default character and add the plugin to it
      logger.info(`Starting default character with plugin: ${pluginModule.name || 'unnamed plugin'}`);
      await startAgent(
        defaultCharacter,
        server,
        undefined,
        [pluginModule]
      );
      logger.info(`Default character started with plugin successfully`);
    } else if (isProject && !useDefaultCharacter && projectModule?.default?.agents && Array.isArray(projectModule.default.agents)) {
      // Load all project agents, call their init and register their plugins
      const project = projectModule.default as import('@elizaos/core').Project;
      logger.info(`Found ${project.agents.length} agents in project`);
      
      const startedAgents = [];
      for (const agent of project.agents) {
        try {
          logger.info(`Starting agent: ${agent.character.name}`);
          const runtime = await startAgent(
            agent.character,
            server,
            agent.init,
            agent.plugins || []
          );
          startedAgents.push(runtime);
        } catch (agentError) {
          logger.error(`Error starting agent ${agent.character.name}: ${agentError}`);
        }
      }
      
      if (startedAgents.length === 0) {
        logger.warn('Failed to start any agents from project, falling back to default character');
        await startAgent(defaultCharacter, server);
      } else {
        logger.info(`Successfully started ${startedAgents.length} agents from project`);
      }
    } else if (args.swarm && Array.isArray(args.swarm) && args.swarm.length > 0) {
      // Keep legacy swarm support for backward compatibility
      const members = [];
      for (const swarmMember of args.swarm) {
        const runtime = await startAgent(
          swarmMember.character,
          server,
          swarmMember.init,
          swarmMember.plugins
        );
        members.push(runtime);
      }
      logger.info("Loaded characters from swarm configuration");
    } else {
      // Default behavior: load characters from arguments or use default
      let characters = [];
      if (charactersArg || hasValidRemoteUrls()) {
        characters = await loadCharacters(charactersArg);
      } else {
        characters = [defaultCharacter];
      }

      for (const character of characters) {
        await startAgent(character, server);
      }
    }
  } catch (error) {
    logger.error("Error starting agents:", error);
  }

  // Rest of the function remains the same...
  while (!(await checkPortAvailable(serverPort))) {
    logger.warn(`Port ${serverPort} is in use, trying ${serverPort + 1}`);
    serverPort++;
  }

  server.start(serverPort);

  if (serverPort !== Number.parseInt(settings.SERVER_PORT || "3000")) {
    logger.log(`Server started on alternate port ${serverPort}`);
  }

  logger.info(
    "Run `bun start:client` to start the client and visit the outputted URL (http://localhost:5173) to chat with your agents. When running multiple agents, use client with different port `SERVER_PORT=3001 bun start:client`"
  );
};

// Convert this into a command
export const start = new Command("start")
  .description("Start the ElizaOS server with project agents")
  .action(async () => {
    startAgents().catch((error) => {
      logger.error("Unhandled error in startAgents:", error.message);
      process.exit(1);
    });
    
    // Prevent unhandled exceptions from crashing the process if desired
    if (
      process.env.PREVENT_UNHANDLED_EXIT &&
      parseBooleanFromText(process.env.PREVENT_UNHANDLED_EXIT)
    ) {
      // Handle uncaught exceptions to prevent the process from crashing
      process.on("uncaughtException", (err) => {
        console.error("uncaughtException", err);
      });
    
      // Handle unhandled rejections to prevent the process from crashing
      process.on("unhandledRejection", (err) => {
        console.error("unhandledRejection", err);
      });
    }
  });

export default start;
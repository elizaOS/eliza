import { AgentRuntime, logger, type UUID, type Project as ProjectType, type ProjectAgent } from "@elizaos/core";
import { resolve } from "node:path";
import { v4 as uuidv4 } from "uuid";
import * as fs from "node:fs";

export interface LoadedProject {
  runtimes: AgentRuntime[];
  path: string;
  agents: ProjectAgent[];
}

/**
 * Loads a project from the specified path
 * @param path Path to the project directory
 * @returns The loaded project with all its agents
 */
export async function loadProject(path: string): Promise<LoadedProject> {
  try {
    const projectPath = resolve(path);
    logger.info(`Loading project from ${projectPath}`);
    
    let projectConfig: ProjectType | undefined;

    // Check if we're in a project with a package.json
    const packageJsonPath = resolve(projectPath, "package.json");
    if (fs.existsSync(packageJsonPath)) {
      // Read and parse package.json to check if it's a project
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));

      // Check if this is a project (package.json contains 'eliza' section with type='project')
      const isProject = packageJson.eliza?.type === "project" || 
                       packageJson.description?.toLowerCase().includes("project");

      if (isProject) {
        // First try to load from src/index.ts or src/index.js
        const srcIndexPaths = [
          resolve(projectPath, "src", "index.ts"),
          resolve(projectPath, "src", "index.js"),
          resolve(projectPath, "dist", "index.js")
        ];

        for (const indexPath of srcIndexPaths) {
          if (fs.existsSync(indexPath)) {
            try {
              logger.info(`Trying to load project from ${indexPath}`);
              const importedModule = await import(`file://${indexPath}`);
              
              // Check if it exports a project with agents
              if (importedModule.default?.agents || importedModule.project?.agents) {
                projectConfig = importedModule.default || importedModule.project;
                logger.info(`Successfully loaded project with ${projectConfig.agents.length} agents`);
                break;
              }
            } catch (importError) {
              logger.warn(`Error importing ${indexPath}: ${importError}`);
            }
          }
        }

        // If no project found in src/index, try package.json main entry
        if (!projectConfig && packageJson.main) {
          const mainPath = resolve(projectPath, packageJson.main);
          if (fs.existsSync(mainPath)) {
            try {
              const importedModule = await import(`file://${mainPath}`);
              if (importedModule.default?.agents || importedModule.project?.agents) {
                projectConfig = importedModule.default || importedModule.project;
              }
            } catch (importError) {
              logger.warn(`Error importing main entry: ${importError}`);
            }
          }
        }
      }
    }

    // If no project found in package.json, look for project files
    if (!projectConfig) {
      const projectFiles = ["project.json", "eliza.json", "agents.json"];

      for (const file of projectFiles) {
        const filePath = resolve(projectPath, file);
        if (fs.existsSync(filePath)) {
          try {
            const fileContent = fs.readFileSync(filePath, "utf-8");
            const projectData = JSON.parse(fileContent);

            if (projectData.agents) {
              projectConfig = projectData;
              break;
            }
          } catch (error) {
            logger.warn(`Error reading possible project file ${file}: ${error}`);
          }
        }
      }
    }

    // If still no project found, use default test configuration
    if (!projectConfig) {
      logger.warn("No project configuration found, using default test configuration");
      projectConfig = {
        agents: [{
          character: {
            name: "Test Agent",
            bio: ["A test agent for running automated tests"],
            templates: {},
            settings: {},
            system: "You are a test agent for running automated tests.",
            messageExamples: []
          }
        }]
      };
    }

    // Get all agents
    const agents = projectConfig.agents;
    if (!agents || agents.length === 0) {
      logger.error("No agents defined in project configuration");
      throw new Error("No agents defined in project configuration");
    }

    logger.info(`Found ${agents.length} agents in project`);

    // Initialize runtimes for all agents
    const runtimes: AgentRuntime[] = [];
    for (const agent of agents) {
      logger.info(`Creating runtime for agent: ${agent.character.name}`);
    const runtime = new AgentRuntime({
      agentId: uuidv4() as UUID,
      character: agent.character,
      plugins: agent.plugins || []
    });
    
    // Initialize the agent if it has an init function
    if (agent.init) {
      await agent.init(runtime);
      }
      
      runtimes.push(runtime);
    }
    
    return {
      runtimes,
      path: projectPath,
      agents
    };
  } catch (error) {
    logger.error("Failed to load project:", error);
    throw error;
  }
} 
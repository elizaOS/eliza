import { displayBanner, handleError } from '@/src/utils';
import { Command } from 'commander';
import path from 'node:path';
import * as clack from '@clack/prompts';
import colors from 'yoctocolors';
import { logger } from '@elizaos/core';

import { validateCreateOptions, validateProjectName } from './utils';
import { selectDatabase, selectAIModel } from './utils';
import { createProject, createPlugin, createAgent, createTEEProject } from './actions';
import type { CreateOptions } from './types';

export const create = new Command('create')
  .description('Create a new ElizaOS project, plugin, agent, or TEE project')
  .argument('[name]', 'name of the project/plugin/agent to create')
  .option('--dir <dir>', 'directory to create the project in', '.')
  .option('--yes, -y', 'skip prompts and use defaults')
  .option('--type <type>', 'type of project to create (project, plugin, agent, tee)', 'project')
  .action(async (name?: string, opts?: any) => {
    try {
      // Set non-interactive mode if environment variable is set or if -y/--yes flag is present in process.argv
      if (
        process.env.ELIZA_NONINTERACTIVE === '1' ||
        process.env.ELIZA_NONINTERACTIVE === 'true' ||
        process.argv.includes('-y') ||
        process.argv.includes('--yes')
      ) {
        if (opts) {
          opts.yes = true;
        } else {
          opts = { yes: true };
        }
      }

      // Validate and parse options
      const options: CreateOptions = validateCreateOptions(opts || {});
      const isNonInteractive = options.yes;

      if (!isNonInteractive) {
        await displayBanner();
        clack.intro(colors.inverse(' Creating ElizaOS Project '));
      }

      let projectType = options.type;
      let projectName = name;

      // If no name provided, prompt for type first then name
      if (!projectName) {
        if (!isNonInteractive) {
          const selectedType = await clack.select({
            message: 'What would you like to create?',
            options: [
              {
                label: 'Project - Full ElizaOS application',
                value: 'project',
                hint: 'Complete project with runtime, agents, and all features',
              },
              {
                label: 'Plugin - Custom ElizaOS plugin',
                value: 'plugin',
                hint: 'Extend ElizaOS functionality with custom plugins',
              },
              {
                label: 'Agent - Character definition file',
                value: 'agent',
                hint: 'Create a new agent character file',
              },
              {
                label: 'TEE Project - Trusted Execution Environment project',
                value: 'tee',
                hint: 'Secure computing environment for privacy-focused applications',
              },
            ],
            initialValue: 'project',
          });

          if (clack.isCancel(selectedType)) {
            clack.cancel('Operation cancelled.');
            process.exit(0);
          }

          projectType = selectedType as 'project' | 'plugin' | 'agent' | 'tee';
        }

        // Prompt for name
        if (!isNonInteractive) {
          const nameInput = await clack.text({
            message: `What is the name of your ${projectType}?`,
            placeholder: `my-${projectType}`,
            validate: (value) => {
              if (!value) return 'Name is required';

              // Validate project/plugin names differently than agent names
              if (projectType === 'agent') {
                return value.length > 0 ? undefined : 'Agent name cannot be empty';
              }

              const validation = validateProjectName(value);
              return validation.isValid ? undefined : validation.error;
            },
          });

          if (clack.isCancel(nameInput)) {
            clack.cancel('Operation cancelled.');
            process.exit(0);
          }

          projectName = nameInput as string;
        } else {
          throw new Error(`Project name is required. Usage: elizaos create [name]`);
        }
      }

      // Validate project name for non-agent types
      if (projectType !== 'agent') {
        const nameValidation = validateProjectName(projectName!);
        if (!nameValidation.isValid) {
          throw new Error(nameValidation.error);
        }
      }

      const targetDir = options.dir;

      // Handle different project types
      switch (projectType) {
        case 'plugin':
          await createPlugin(projectName!, targetDir, isNonInteractive);
          break;

        case 'agent':
          await createAgent(projectName!, targetDir, isNonInteractive);
          break;

        case 'tee': {
          // TEE projects need database and AI model selection
          let database = 'pglite';
          let aiModel = 'local';

          if (!isNonInteractive) {
            database = await selectDatabase();
            aiModel = await selectAIModel();
          }

          await createTEEProject(projectName!, targetDir, database, aiModel, isNonInteractive);
          break;
        }

        case 'project':
        default: {
          // Regular projects need database and AI model selection
          let database = 'pglite';
          let aiModel = 'local';

          if (!isNonInteractive) {
            database = await selectDatabase();
            aiModel = await selectAIModel();
          }

          await createProject(projectName!, targetDir, database, aiModel, isNonInteractive);
          break;
        }
      }

      if (!isNonInteractive) {
        clack.outro(colors.green('Project created successfully! 🎉'));
      }
    } catch (error) {
      if (!opts?.yes) {
        clack.cancel('Failed to create project.');
      }
      logger.error('Create command failed:', error);
      handleError(error);
      process.exit(1);
    }
  });

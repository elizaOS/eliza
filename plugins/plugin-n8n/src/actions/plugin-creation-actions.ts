import { Action, HandlerCallback, IAgentRuntime, Memory, State } from '@elizaos/core';
import { z } from 'zod';
import { type PluginSpecification } from '../services/plugin-creation-service.ts';
import { getPluginCreationService } from '../utils/get-plugin-creation-service.ts';
import { isValidJsonSpecification, validatePrompt } from '../utils/validation.ts';

// Zod schema for plugin specification validation
const PluginSpecificationSchema = z.object({
  name: z.string().regex(/^@?[a-zA-Z0-9-_]+\/[a-zA-Z0-9-_]+$/, 'Invalid plugin name format'),
  description: z.string().min(10, 'Description must be at least 10 characters'),
  version: z
    .string()
    .regex(/^\d+\.\d+\.\d+$/, 'Version must be in semver format')
    .optional()
    .default('1.0.0'),
  actions: z
    .array(
      z.object({
        name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]*$/, 'Action name must be alphanumeric'),
        description: z.string(),
        parameters: z.record(z.any()).optional(),
      })
    )
    .optional(),
  providers: z
    .array(
      z.object({
        name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]*$/, 'Provider name must be alphanumeric'),
        description: z.string(),
        dataStructure: z.record(z.any()).optional(),
      })
    )
    .optional(),
  services: z
    .array(
      z.object({
        name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]*$/, 'Service name must be alphanumeric'),
        description: z.string(),
        methods: z.array(z.string()).optional(),
      })
    )
    .optional(),
  evaluators: z
    .array(
      z.object({
        name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]*$/, 'Evaluator name must be alphanumeric'),
        description: z.string(),
        triggers: z.array(z.string()).optional(),
      })
    )
    .optional(),
  dependencies: z.record(z.string()).optional(),
  environmentVariables: z
    .array(
      z.object({
        name: z.string(),
        description: z.string(),
        required: z.boolean(),
        sensitive: z.boolean(),
      })
    )
    .optional(),
});

export const createPluginAction: Action = {
  name: 'createPlugin',
  description: 'Create a new plugin from a specification using AI assistance',
  similes: [
    'generate plugin',
    'build plugin',
    'make plugin',
    'develop plugin',
    'create extension',
    'build extension',
  ],
  examples: [
    [
      {
        name: 'user',
        content: {
          text: 'Create a plugin for managing user preferences',
        },
      },
      {
        name: 'agent',
        content: {
          text: "I'll create a user preferences management plugin for you. Let me start by generating the necessary components...",
        },
      },
    ],
    [
      {
        name: 'user',
        content: {
          text: 'Build a plugin that adds weather information capabilities',
        },
      },
      {
        name: 'agent',
        content: {
          text: "I'll create a weather information plugin with actions for fetching current weather, forecasts, and weather alerts.",
        },
      },
    ],
  ],
  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    const service = getPluginCreationService(runtime);
    if (!service) {
      return false;
    }

    // Check if there's already an active job
    const jobs = service.getAllJobs();
    const activeJob = jobs.find((job) => job.status === 'running' || job.status === 'pending');
    if (activeJob) {
      return false;
    }

    // Validate the message contains valid JSON
    if (!isValidJsonSpecification(message.content.text)) {
      return false;
    }

    return validatePrompt(message);
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<string> => {
    try {
      const service = getPluginCreationService(runtime);
      if (!service) {
        return 'Plugin creation service not available. Please ensure the plugin is properly installed.';
      }

      // Parse and validate specification
      let specification: PluginSpecification;
      try {
        const parsed = JSON.parse(message.content.text);
        specification = PluginSpecificationSchema.parse(parsed) as PluginSpecification;
      } catch (error) {
        if (error instanceof z.ZodError) {
          return `Invalid plugin specification:\n${error.errors.map((e) => `- ${e.path.join('.')}: ${e.message}`).join('\n')}`;
        }
        return `Failed to parse specification: ${error.message}`;
      }

      const apiKey = runtime.getSetting('ANTHROPIC_API_KEY');
      if (!apiKey) {
        return 'ANTHROPIC_API_KEY is not configured. Please set it to enable AI-powered plugin generation.';
      }

      const jobId = await service.createPlugin(specification, apiKey);

      return `Plugin creation job started successfully!\n\nJob ID: ${jobId}\nPlugin: ${specification.name}\n\nUse 'checkPluginCreationStatus' to monitor progress.`;
    } catch (error) {
      return `Failed to create plugin: ${error.message}`;
    }
  },
};

export const checkPluginCreationStatusAction: Action = {
  name: 'checkPluginCreationStatus',
  description: 'Check the status of a plugin creation job',
  similes: [
    'plugin status',
    'check plugin progress',
    'plugin creation status',
    'get plugin status',
  ],
  examples: [
    [
      {
        name: 'user',
        content: {
          text: "What's the status of my plugin creation?",
        },
      },
      {
        name: 'agent',
        content: {
          text: 'Let me check the status of your plugin creation job...',
        },
      },
    ],
  ],
  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    const service = getPluginCreationService(runtime);
    if (!service) {
      return false;
    }

    const jobs = service.getAllJobs();
    return jobs.length > 0;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<string> => {
    try {
      const service = getPluginCreationService(runtime);
      if (!service) {
        return 'Plugin creation service not available.';
      }

      const jobs = service.getAllJobs();
      if (jobs.length === 0) {
        return 'No plugin creation jobs found.';
      }

      // Check for job ID in message
      const jobIdMatch = message.content.text.match(
        /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i
      );
      let targetJob;

      if (jobIdMatch) {
        targetJob = service.getJobStatus(jobIdMatch[0]);
        if (!targetJob) {
          return `Job with ID ${jobIdMatch[0]} not found.`;
        }
      } else {
        // Get the most recent active job
        targetJob = jobs
          .filter((job) => job.status === 'running' || job.status === 'pending')
          .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0];

        if (!targetJob) {
          // Get the most recent job of any status
          targetJob = jobs.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0];
        }
      }

      if (!targetJob) {
        return 'No plugin creation jobs found.';
      }

      let response = `📦 Plugin Creation Status\n`;
      response += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
      response += `🆔 Job ID: ${targetJob.id}\n`;
      response += `📌 Plugin: ${targetJob.specification.name}\n`;
      response += `📊 Status: ${targetJob.status.toUpperCase()}\n`;
      response += `🔄 Phase: ${targetJob.currentPhase}\n`;
      response += `📈 Progress: ${Math.round(targetJob.progress)}%\n`;
      response += `⏱️ Started: ${targetJob.startedAt.toLocaleString()}\n`;

      if (targetJob.completedAt) {
        response += `✅ Completed: ${targetJob.completedAt.toLocaleString()}\n`;
        const duration = targetJob.completedAt.getTime() - targetJob.startedAt.getTime();
        response += `⏳ Duration: ${Math.round(duration / 1000)}s\n`;
      }

      if (targetJob.logs.length > 0) {
        response += `\n📝 Recent Activity:\n`;
        targetJob.logs.slice(-5).forEach((log) => {
          response += `  ${log}\n`;
        });
      }

      if (targetJob.status === 'completed') {
        response += `\n✅ Plugin created successfully!\n`;
        response += `📂 Location: ${targetJob.outputPath}\n`;
      } else if (targetJob.status === 'failed') {
        response += `\n❌ Plugin creation failed\n`;
        if (targetJob.error) {
          response += `Error: ${targetJob.error}\n`;
        }
      }

      return response;
    } catch (error) {
      return `Failed to check status: ${error.message}`;
    }
  },
};

export const cancelPluginCreationAction: Action = {
  name: 'cancelPluginCreation',
  description: 'Cancel the current plugin creation job',
  similes: ['stop plugin creation', 'abort plugin creation', 'cancel plugin'],
  examples: [
    [
      {
        name: 'user',
        content: {
          text: 'Cancel the plugin creation',
        },
      },
      {
        name: 'agent',
        content: {
          text: "I'll cancel the current plugin creation job.",
        },
      },
    ],
  ],
  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    const service = getPluginCreationService(runtime);
    if (!service) {
      return false;
    }

    const jobs = service.getAllJobs();
    const activeJob = jobs.find((job) => job.status === 'running' || job.status === 'pending');
    return !!activeJob;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<string> => {
    try {
      const service = getPluginCreationService(runtime);
      if (!service) {
        return 'Plugin creation service not available.';
      }

      const jobs = service.getAllJobs();
      const activeJob = jobs.find((job) => job.status === 'running' || job.status === 'pending');

      if (!activeJob) {
        return 'No active plugin creation job to cancel.';
      }

      service.cancelJob(activeJob.id);
      return `Plugin creation job has been cancelled.\n\nJob ID: ${activeJob.id}\nPlugin: ${activeJob.specification.name}`;
    } catch (error) {
      return `Failed to cancel job: ${error.message}`;
    }
  },
};

export const createPluginFromDescriptionAction: Action = {
  name: 'createPluginFromDescription',
  description: 'Create a plugin from a natural language description',
  similes: ['describe plugin', 'plugin from description', 'explain plugin', 'I need a plugin that'],
  examples: [
    [
      {
        name: 'user',
        content: {
          text: 'I need a plugin that helps manage todo lists with add, remove, and list functionality',
        },
      },
      {
        name: 'agent',
        content: {
          text: "I'll create a todo list management plugin based on your description. This will include actions for adding, removing, and listing todos.",
        },
      },
    ],
  ],
  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    const service = getPluginCreationService(runtime);
    if (!service) {
      return false;
    }

    const jobs = service.getAllJobs();
    const activeJob = jobs.find((job) => job.status === 'running' || job.status === 'pending');
    if (activeJob) {
      return false;
    }

    return message.content.text && message.content.text.length > 20;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<string> => {
    try {
      const service = getPluginCreationService(runtime);
      if (!service) {
        return 'Plugin creation service not available.';
      }

      const apiKey = runtime.getSetting('ANTHROPIC_API_KEY');
      if (!apiKey) {
        return 'ANTHROPIC_API_KEY is not configured. Please set it to enable AI-powered plugin generation.';
      }

      // Generate specification from description
      const specification = await generatePluginSpecification(message.content.text, runtime);

      // Validate the generated specification
      try {
        PluginSpecificationSchema.parse(specification);
      } catch (error) {
        if (error instanceof z.ZodError) {
          return `Failed to generate valid specification:\n${error.errors.map((e) => `- ${e.path.join('.')}: ${e.message}`).join('\n')}`;
        }
      }

      const jobId = await service.createPlugin(specification, apiKey);

      return (
        `I'm creating a plugin based on your description!\n\n` +
        `📦 Plugin: ${specification.name}\n` +
        `📝 Description: ${specification.description}\n` +
        `🆔 Job ID: ${jobId}\n\n` +
        `Components to be created:\n` +
        `${specification.actions?.length ? `- ${specification.actions.length} actions\n` : ''}` +
        `${specification.providers?.length ? `- ${specification.providers.length} providers\n` : ''}` +
        `${specification.services?.length ? `- ${specification.services.length} services\n` : ''}` +
        `${specification.evaluators?.length ? `- ${specification.evaluators.length} evaluators\n` : ''}\n` +
        `Use 'checkPluginCreationStatus' to monitor progress.`
      );
    } catch (error) {
      return `Failed to create plugin: ${error.message}`;
    }
  },
};

// Enhanced helper function to generate plugin specification from natural language
async function generatePluginSpecification(
  description: string,
  runtime: IAgentRuntime
): Promise<PluginSpecification> {
  const lowerDesc = description.toLowerCase();

  // Detect plugin type and generate appropriate name
  let name = '@elizaos/plugin-';
  let pluginType = 'custom';

  if (lowerDesc.includes('weather')) {
    pluginType = 'weather';
    name += 'weather';
  } else if (lowerDesc.includes('database') || lowerDesc.includes('sql')) {
    pluginType = 'database';
    name += 'database';
  } else if (lowerDesc.includes('api') || lowerDesc.includes('rest')) {
    pluginType = 'api';
    name += 'api';
  } else if (lowerDesc.includes('todo') || lowerDesc.includes('task')) {
    pluginType = 'todo';
    name += 'todo';
  } else if (lowerDesc.includes('email') || lowerDesc.includes('mail')) {
    pluginType = 'email';
    name += 'email';
  } else if (lowerDesc.includes('chat') || lowerDesc.includes('message')) {
    pluginType = 'chat';
    name += 'chat';
  } else {
    // Generate name from first significant word
    const words = description.split(/\s+/).filter((w) => w.length > 4);
    name += words[0]?.toLowerCase() || 'custom';
  }

  const specification: PluginSpecification = {
    name,
    description: description.slice(0, 200), // Limit description length
    version: '1.0.0',
    actions: [],
    providers: [],
    services: [],
    evaluators: [],
  };

  // Detect actions based on keywords
  const actionKeywords = {
    create: ['create', 'add', 'new', 'generate', 'make'],
    read: ['get', 'fetch', 'retrieve', 'list', 'show', 'display'],
    update: ['update', 'modify', 'change', 'edit', 'set'],
    delete: ['delete', 'remove', 'clear', 'destroy'],
    execute: ['execute', 'run', 'perform', 'do', 'process'],
  };

  for (const [actionType, keywords] of Object.entries(actionKeywords)) {
    if (keywords.some((kw) => lowerDesc.includes(kw))) {
      specification.actions?.push({
        name: `${actionType}${pluginType.charAt(0).toUpperCase() + pluginType.slice(1)}`,
        description: `${actionType.charAt(0).toUpperCase() + actionType.slice(1)} operation for ${pluginType}`,
        parameters: {},
      });
    }
  }

  // Detect if providers are needed
  if (
    lowerDesc.includes('provide') ||
    lowerDesc.includes('information') ||
    lowerDesc.includes('data') ||
    lowerDesc.includes('context')
  ) {
    specification.providers?.push({
      name: `${pluginType}Provider`,
      description: `Provides ${pluginType} data and context`,
      dataStructure: {},
    });
  }

  // Detect if services are needed
  if (
    lowerDesc.includes('service') ||
    lowerDesc.includes('background') ||
    lowerDesc.includes('monitor') ||
    lowerDesc.includes('watch')
  ) {
    specification.services?.push({
      name: `${pluginType}Service`,
      description: `Background service for ${pluginType} operations`,
      methods: ['start', 'stop', 'status'],
    });
  }

  // Detect if evaluators are needed
  if (
    lowerDesc.includes('evaluate') ||
    lowerDesc.includes('analyze') ||
    lowerDesc.includes('check') ||
    lowerDesc.includes('validate')
  ) {
    specification.evaluators?.push({
      name: `${pluginType}Evaluator`,
      description: `Evaluates and analyzes ${pluginType} data`,
      triggers: [],
    });
  }

  // Ensure at least one component exists
  if (
    !specification.actions?.length &&
    !specification.providers?.length &&
    !specification.services?.length &&
    !specification.evaluators?.length
  ) {
    specification.actions = [
      {
        name: `handle${pluginType.charAt(0).toUpperCase() + pluginType.slice(1)}`,
        description: `Main handler for ${pluginType} operations`,
      },
    ];
  }

  return specification;
}

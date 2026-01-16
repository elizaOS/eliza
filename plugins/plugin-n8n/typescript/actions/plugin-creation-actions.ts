import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { z } from "zod";
import { requireActionSpec } from "../generated/specs/spec-helpers";
import type { PluginCreationJob, PluginSpecification } from "../types";
import { getPluginCreationService } from "../utils/get-plugin-creation-service";
import { isValidJsonSpecification, validatePrompt } from "../utils/validation";

const PluginSpecificationSchema = z.object({
  name: z.string().regex(/^@?[a-zA-Z0-9-_]+\/[a-zA-Z0-9-_]+$/, "Invalid plugin name format"),
  description: z.string().min(10, "Description must be at least 10 characters"),
  version: z
    .string()
    .regex(/^\d+\.\d+\.\d+$/, "Version must be in semver format")
    .optional()
    .default("1.0.0"),
  actions: z
    .array(
      z.object({
        name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]*$/, "Action name must be alphanumeric"),
        description: z.string(),
        parameters: z.record(z.string(), z.string()).optional(),
      })
    )
    .optional(),
  providers: z
    .array(
      z.object({
        name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]*$/, "Provider name must be alphanumeric"),
        description: z.string(),
        dataStructure: z.record(z.string(), z.string()).optional(),
      })
    )
    .optional(),
  services: z
    .array(
      z.object({
        name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]*$/, "Service name must be alphanumeric"),
        description: z.string(),
        methods: z.array(z.string()).optional(),
      })
    )
    .optional(),
  evaluators: z
    .array(
      z.object({
        name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]*$/, "Evaluator name must be alphanumeric"),
        description: z.string(),
        triggers: z.array(z.string()).optional(),
      })
    )
    .optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
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

const spec = requireActionSpec("PLUGIN-CREATION-ACTIONS");

export const createPluginAction: Action = {
  name: spec.name,
  description: spec.description,
  similes: spec.similes ? [...spec.similes] : [],
  examples: [
    [
      {
        name: "user",
        content: {
          text: "Create a plugin for managing user preferences",
        },
      },
      {
        name: "agent",
        content: {
          text: "I'll create a user preferences management plugin for you. Let me start by generating the necessary components...",
        },
      },
    ],
    [
      {
        name: "user",
        content: {
          text: "Build a plugin that adds weather information capabilities",
        },
      },
      {
        name: "agent",
        content: {
          text: "I'll create a weather information plugin with actions for fetching current weather, forecasts, and weather alerts.",
        },
      },
    ],
  ],
  validate: async (runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    const service = getPluginCreationService(runtime);
    if (!service) {
      return false;
    }

    const jobs = service.getAllJobs();
    const activeJob = jobs.find((job) => job.status === "running" || job.status === "pending");
    if (activeJob) {
      return false;
    }

    if (!isValidJsonSpecification(message.content.text)) {
      return false;
    }

    return validatePrompt(message);
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: { [key: string]: string },
    _callback?: HandlerCallback
  ): Promise<ActionResult> => {
    try {
      const service = getPluginCreationService(runtime);
      if (!service) {
        return {
          success: false,
          text: "Plugin creation service not available. Please ensure the plugin is properly installed.",
        };
      }

      let specification: PluginSpecification;
      try {
        const parsed = JSON.parse(message.content.text ?? "{}");
        specification = PluginSpecificationSchema.parse(parsed) as PluginSpecification;
      } catch (error) {
        if (error instanceof z.ZodError) {
          return {
            success: false,
            text: `Invalid plugin specification:\n${error.issues.map((e) => `- ${e.path.join(".")}: ${e.message}`).join("\n")}`,
          };
        }
        return {
          success: false,
          text: `Failed to parse specification: ${(error as Error).message}`,
        };
      }

      const apiKey = runtime.getSetting("ANTHROPIC_API_KEY");
      if (!apiKey || typeof apiKey !== "string") {
        return {
          success: false,
          text: "ANTHROPIC_API_KEY is not configured. Please set it to enable AI-powered plugin generation.",
        };
      }

      const jobId = await service.createPlugin(specification, apiKey);

      return {
        success: true,
        text: `Plugin creation job started successfully!\n\nJob ID: ${jobId}\nPlugin: ${specification.name}\n\nUse 'checkPluginCreationStatus' to monitor progress.`,
        data: {
          jobId,
          pluginName: specification.name,
        },
      };
    } catch (error) {
      return {
        success: false,
        text: `Failed to create plugin: ${(error as Error).message}`,
        error: (error as Error).message,
      };
    }
  },
};

const checkStatusSpec = requireActionSpec("CHECK_PLUGIN_CREATION_STATUS");

export const checkPluginCreationStatusAction: Action = {
  name: checkStatusSpec.name,
  description: checkStatusSpec.description,
  similes: checkStatusSpec.similes ? [...checkStatusSpec.similes] : [],
  examples: (checkStatusSpec.examples ?? []) as ActionExample[][],
  validate: async (runtime: IAgentRuntime, _message: Memory, _state?: State): Promise<boolean> => {
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
    _state?: State,
    _options?: { [key: string]: string },
    _callback?: HandlerCallback
  ): Promise<ActionResult> => {
    try {
      const service = getPluginCreationService(runtime);
      if (!service) {
        return {
          success: false,
          text: "Plugin creation service not available.",
        };
      }

      const jobs = service.getAllJobs();
      if (jobs.length === 0) {
        return {
          success: false,
          text: "No plugin creation jobs found.",
        };
      }

      const jobIdMatch = (message.content.text ?? "").match(
        /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i
      );
      let targetJob: PluginCreationJob | undefined;

      if (jobIdMatch) {
        targetJob = service.getJobStatus(jobIdMatch[0]);
        if (!targetJob) {
          return {
            success: false,
            text: `Job with ID ${jobIdMatch[0]} not found.`,
          };
        }
      } else {
        targetJob = jobs
          .filter((job) => job.status === "running" || job.status === "pending")
          .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0];

        if (!targetJob) {
          targetJob = jobs.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0];
        }
      }

      if (!targetJob) {
        return {
          success: false,
          text: "No plugin creation jobs found.",
        };
      }

      let response = `Plugin Creation Status\n`;
      response += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
      response += `Job ID: ${targetJob.id}\n`;
      response += `Plugin: ${targetJob.specification.name}\n`;
      response += `Status: ${targetJob.status.toUpperCase()}\n`;
      response += `Phase: ${targetJob.currentPhase}\n`;
      response += `Progress: ${Math.round(targetJob.progress)}%\n`;
      response += `Started: ${targetJob.startedAt.toLocaleString()}\n`;

      if (targetJob.completedAt) {
        response += `Completed: ${targetJob.completedAt.toLocaleString()}\n`;
        const duration = targetJob.completedAt.getTime() - targetJob.startedAt.getTime();
        response += `Duration: ${Math.round(duration / 1000)}s\n`;
      }

      if (targetJob.logs.length > 0) {
        response += `\nRecent Activity:\n`;
        targetJob.logs.slice(-5).forEach((log) => {
          response += `  ${log}\n`;
        });
      }

      if (targetJob.status === "completed") {
        response += `\nPlugin created successfully!\n`;
        response += `Location: ${targetJob.outputPath}\n`;
      } else if (targetJob.status === "failed") {
        response += `\nPlugin creation failed\n`;
        if (targetJob.error) {
          response += `Error: ${targetJob.error}\n`;
        }
      }

      return {
        success: true,
        text: response,
        data: {
          jobId: targetJob.id,
          status: targetJob.status,
          progress: targetJob.progress,
        },
      };
    } catch (error) {
      return {
        success: false,
        text: `Failed to check status: ${(error as Error).message}`,
        error: (error as Error).message,
      };
    }
  },
};

const cancelSpec = requireActionSpec("CANCEL_PLUGIN_CREATION");

export const cancelPluginCreationAction: Action = {
  name: cancelSpec.name,
  description: cancelSpec.description,
  similes: cancelSpec.similes ? [...cancelSpec.similes] : [],
  examples: (cancelSpec.examples ?? []) as ActionExample[][],
  validate: async (runtime: IAgentRuntime, _message: Memory, _state?: State): Promise<boolean> => {
    const service = getPluginCreationService(runtime);
    if (!service) {
      return false;
    }

    const jobs = service.getAllJobs();
    const activeJob = jobs.find((job) => job.status === "running" || job.status === "pending");
    return !!activeJob;
  },
  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    _options?: { [key: string]: string },
    _callback?: HandlerCallback
  ): Promise<ActionResult> => {
    try {
      const service = getPluginCreationService(runtime);
      if (!service) {
        return {
          success: false,
          text: "Plugin creation service not available.",
        };
      }

      const jobs = service.getAllJobs();
      const activeJob = jobs.find((job) => job.status === "running" || job.status === "pending");

      if (!activeJob) {
        return {
          success: false,
          text: "No active plugin creation job to cancel.",
        };
      }

      service.cancelJob(activeJob.id);
      return {
        success: true,
        text: `Plugin creation job has been cancelled.\n\nJob ID: ${activeJob.id}\nPlugin: ${activeJob.specification.name}`,
        data: {
          jobId: activeJob.id,
          pluginName: activeJob.specification.name,
        },
      };
    } catch (error) {
      return {
        success: false,
        text: `Failed to cancel job: ${(error as Error).message}`,
        error: (error as Error).message,
      };
    }
  },
};

const createFromDescSpec = requireActionSpec("CREATE_PLUGIN_FROM_DESCRIPTION");

export const createPluginFromDescriptionAction: Action = {
  name: createFromDescSpec.name,
  description: createFromDescSpec.description,
  similes: createFromDescSpec.similes ? [...createFromDescSpec.similes] : [],
  examples: (createFromDescSpec.examples ?? []) as ActionExample[][],
  validate: async (runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    const service = getPluginCreationService(runtime);
    if (!service) {
      return false;
    }

    const jobs = service.getAllJobs();
    const activeJob = jobs.find((job) => job.status === "running" || job.status === "pending");
    if (activeJob) {
      return false;
    }

    return message.content.text !== null && message.content.text.length > 20;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: { [key: string]: string },
    _callback?: HandlerCallback
  ): Promise<ActionResult> => {
    try {
      const service = getPluginCreationService(runtime);
      if (!service) {
        return {
          success: false,
          text: "Plugin creation service not available.",
        };
      }

      const apiKey = runtime.getSetting("ANTHROPIC_API_KEY");
      if (!apiKey || typeof apiKey !== "string") {
        return {
          success: false,
          text: "ANTHROPIC_API_KEY is not configured. Please set it to enable AI-powered plugin generation.",
        };
      }

      const specification = generatePluginSpecification(message.content.text ?? "");

      try {
        PluginSpecificationSchema.parse(specification);
      } catch (error) {
        if (error instanceof z.ZodError) {
          return {
            success: false,
            text: `Failed to generate valid specification:\n${error.issues.map((e) => `- ${e.path.join(".")}: ${e.message}`).join("\n")}`,
          };
        }
      }

      const jobId = await service.createPlugin(specification, apiKey);

      return {
        success: true,
        text:
          `Creating plugin based on your description!\n\n` +
          `Plugin: ${specification.name}\n` +
          `Description: ${specification.description}\n` +
          `Job ID: ${jobId}\n\n` +
          `Components to be created:\n` +
          `${specification.actions?.length ? `- ${specification.actions.length} actions\n` : ""}` +
          `${specification.providers?.length ? `- ${specification.providers.length} providers\n` : ""}` +
          `${specification.services?.length ? `- ${specification.services.length} services\n` : ""}` +
          `${specification.evaluators?.length ? `- ${specification.evaluators.length} evaluators\n` : ""}\n` +
          `Use 'checkPluginCreationStatus' to monitor progress.`,
      };
    } catch (error) {
      return {
        success: false,
        text: `Failed to create plugin: ${(error as Error).message}`,
      };
    }
  },
};

function generatePluginSpecification(description: string): PluginSpecification {
  const lowerDesc = description.toLowerCase();

  let name = "@elizaos/plugin-";
  let pluginType = "custom";

  if (lowerDesc.includes("weather")) {
    pluginType = "weather";
    name += "weather";
  } else if (lowerDesc.includes("database") || lowerDesc.includes("sql")) {
    pluginType = "database";
    name += "database";
  } else if (lowerDesc.includes("api") || lowerDesc.includes("rest")) {
    pluginType = "api";
    name += "api";
  } else if (lowerDesc.includes("todo") || lowerDesc.includes("task")) {
    pluginType = "todo";
    name += "todo";
  } else if (lowerDesc.includes("email") || lowerDesc.includes("mail")) {
    pluginType = "email";
    name += "email";
  } else if (lowerDesc.includes("chat") || lowerDesc.includes("message")) {
    pluginType = "chat";
    name += "chat";
  } else {
    const words = description.split(/\s+/).filter((w) => w.length > 4);
    name += words[0]?.toLowerCase() ?? "custom";
  }

  const specification: PluginSpecification = {
    name,
    description: description.slice(0, 200),
    version: "1.0.0",
    actions: [],
    providers: [],
    services: [],
    evaluators: [],
  };

  const actionKeywords: Record<string, string[]> = {
    create: ["create", "add", "new", "generate", "make"],
    read: ["get", "fetch", "retrieve", "list", "show", "display"],
    update: ["update", "modify", "change", "edit", "set"],
    delete: ["delete", "remove", "clear", "destroy"],
    execute: ["execute", "run", "perform", "do", "process"],
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

  if (
    lowerDesc.includes("provide") ||
    lowerDesc.includes("information") ||
    lowerDesc.includes("data") ||
    lowerDesc.includes("context")
  ) {
    specification.providers?.push({
      name: `${pluginType}Provider`,
      description: `Provides ${pluginType} data and context`,
      dataStructure: {},
    });
  }

  if (
    lowerDesc.includes("service") ||
    lowerDesc.includes("background") ||
    lowerDesc.includes("monitor") ||
    lowerDesc.includes("watch")
  ) {
    specification.services?.push({
      name: `${pluginType}Service`,
      description: `Background service for ${pluginType} operations`,
      methods: ["start", "stop", "status"],
    });
  }

  if (
    lowerDesc.includes("evaluate") ||
    lowerDesc.includes("analyze") ||
    lowerDesc.includes("check") ||
    lowerDesc.includes("validate")
  ) {
    specification.evaluators?.push({
      name: `${pluginType}Evaluator`,
      description: `Evaluates and analyzes ${pluginType} data`,
      triggers: [],
    });
  }

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

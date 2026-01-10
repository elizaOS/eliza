import {
  type Plugin,
  ChannelType,
  composePromptFromState,
  createUniqueUuid,
  type Memory,
  type MessagePayload,
  ModelType,
  parseKeyValueXml,
} from '@elizaos/core';
import { EventType } from './types.ts';
import { OODALoopService } from './ooda-service.ts';
import './types.ts'; // Ensure module augmentation is loaded
import { autonomousFeedProvider } from './messageFeed.ts';
import { reflectAction } from './reflect.ts';
import { oodaLoopE2ETests } from './__tests__/e2e/ooda-loop.e2e.ts';
import { worldProvider } from './worldProvider.ts';
import { ResourceMonitorService } from './resource-monitor.ts';
import { AutonomyAPIServer } from './api-server.ts';

// Import real actions that actually do work
import {
  browseWebAction,
  fileOperationAction,
  executeCommandAction,
  analyzeDataAction,
  gitOperationAction,
  packageManagementAction,
} from './actions';

// Declare environment variables for autonomous service configuration
declare global {
  namespace NodeJS {
    interface ProcessEnv {
      AUTONOMOUS_LOOP_INTERVAL?: string;
      AUTONOMOUS_FILE_LOGGING?: string;
      AUTONOMOUS_LOG_DIR?: string;
      AUTONOMOUS_LOG_LEVEL?: string;
      AUTONOMOUS_API_PORT?: string;
    }
  }
}

export const responseTemplate = `Example response:
<response>
    <thought>
        I should order myself a pizza
    </thought>
    <text>
        I'm ordering a pizza
    </text>
    <actions>
        ORDER_PIZZA
    </actions>
    <providers>
        GOOGLE_SEARCH, GOOGLE_MAPS, GOOGLE_TRANSLATE
    </providers>
    <evaluators>
        EVALUATE_PIZZA_ORDER
    </evaluators>
</response>

Note that the above actions and providers do not exist and are just examples.

<providers>
{{providers}}
</providers>

<keys>
"thought" should be a short description of what the agent is thinking about and planning.
"actions" should be a comma-separated list of the actions {{agentName}} plans to take based on the thought (if none, use IGNORE, if simply responding with text, use REPLY)
"providers" should be an optional comma-separated list of the providers that {{agentName}} will use to have the right context for responding and acting
"evaluators" should be an optional comma-separated list of the evaluators that {{agentName}} will use to evaluate the conversation after responding
"text" should be the text of the next message for {{agentName}} which they will send to the conversation.
"simple" should be true if the message is a simple response and false if it is a more complex response that requires planning, knowledge or more context to handle or reply to.
</keys>

<instructions>
You are an autonomous agent working with a copilot to navigate your world. Think, respond to the copilot's latest statements and decide what actions to take next.

Respond using XML format like this:
<response>
    <thought>
        Agent's thinking goes here
    </thought>
    <text>
        The text of the next message for {{agentName}} which they will send to the conversation.
    </text>
    <actions>
        Actions to take next, as comma separated list
    </actions>
    <providers>
        Providers to use next, as comma separated list
    </providers>
    <evaluators>
        Evaluators to use next, as comma separated list
    </evaluators>
</response>

Your response must ONLY include the <response></response> XML block.
</instructions>`;

export const autoPlugin: Plugin = {
  name: 'auto',
  description:
    'Autonomous operations plugin with OODA loop decision-making and real action execution',

  services: [OODALoopService, ResourceMonitorService],

  actions: [
    // Real actions that actually do work
    browseWebAction,
    fileOperationAction,
    executeCommandAction,
    analyzeDataAction,
    gitOperationAction,
    packageManagementAction,
    reflectAction,
  ],

  providers: [autonomousFeedProvider, worldProvider],

  tests: [
    {
      name: 'OODA Loop E2E Tests',
      tests: oodaLoopE2ETests,
    },
  ],

  // Start API server if enabled
  init: async (config: Record<string, string>, runtime: any) => {
    if (process.env.AUTONOMOUS_API_PORT) {
      const port = parseInt(process.env.AUTONOMOUS_API_PORT);
      const apiServer = new AutonomyAPIServer(runtime, port);

      // Hook into OODA service when it starts
      runtime.on('serviceStarted', (service: any) => {
        if (service.constructor.serviceType === 'autonomous') {
          apiServer.setOODAService(service);
        }
      });

      await apiServer.start();
      console.log(`Autonomy API server started on port ${port}`);
    }
  },
};

// Export types for external use
export * from './types';
export { getLogger } from './logging';
export { AutonomyAPIServer } from './api-server';
export { ResourceMonitorService } from './resource-monitor';

export default autoPlugin;

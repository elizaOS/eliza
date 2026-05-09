import {
  type Action,
  type ActionExample,
  type ActionResult,
  elizaLogger,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  ModelType,
  type State,
} from '@elizaos/core';
import type { ITunnelService } from '@elizaos/plugin-tunnel';

const startTunnelTemplate = `
Respond with a JSON object containing the port number to start the ngrok tunnel on.
The user said: "{{userMessage}}"

Extract the port number from their message, or use the default port 3000 if not specified.

Response format:
\`\`\`json
{
  "port": 3000
}
\`\`\`
`;

export const startTunnelAction: Action = {
  name: 'START_TUNNEL',
  similes: ['OPEN_TUNNEL', 'CREATE_TUNNEL', 'NGROK_START', 'TUNNEL_UP'],
  description:
    'Start an ngrok tunnel to expose a local port to the internet. Supports action chaining by providing tunnel metadata that can be used for webhook configuration, API testing, or remote access workflows.',
  validate: async (runtime: IAgentRuntime, _message: Memory) => {
    const tunnelService = runtime.getService<ITunnelService>('tunnel');
    if (!tunnelService) {
      return false;
    }

    // Check if tunnel is already active
    if (tunnelService.isActive()) {
      elizaLogger.warn('Tunnel is already active');
      return false;
    }

    return true;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: any,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const tunnelService = runtime.getService<ITunnelService>('tunnel');
    if (!tunnelService) {
      elizaLogger.error('Tunnel service is not available');
      if (callback) {
        await callback({
          text: 'Tunnel service is not available. Please ensure the ngrok plugin is properly configured.',
        });
      }
      return {
        text: 'Tunnel service is not available. Please ensure the ngrok plugin is properly configured.',
        values: { success: false, error: 'service_unavailable' },
        data: { action: 'START_TUNNEL' },
      };
    }

    if (tunnelService.isActive()) {
      elizaLogger.warn('Tunnel is already active');
      if (callback) {
        await callback({
          text: 'Tunnel is already active. Please stop the existing tunnel before starting a new one.',
        });
      }
      return {
        text: 'Tunnel is already active. Please stop the existing tunnel before starting a new one.',
        values: { success: false, error: 'tunnel_already_active' },
        data: { action: 'START_TUNNEL' },
      };
    }

    elizaLogger.info('Starting ngrok tunnel...');

    try {
      // Extract port from message
      const context = {
        userMessage: message.content.text,
      };

      const portResponse = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt: startTunnelTemplate,
        context,
        temperature: 0.3,
      });

      let port = 3000; // default
      try {
        const parsed = JSON.parse(portResponse);
        if (parsed.port) {
          // Handle both number and string port values
          const portNum = typeof parsed.port === 'string' ? parseInt(parsed.port, 10) : parsed.port;
          if (!Number.isNaN(portNum) && portNum > 0 && portNum <= 65535) {
            port = portNum;
          }
        }
      } catch {
        // Try to extract port from plain text response
        const portMatch = portResponse.match(/\b(\d{1,5})\b/);
        if (portMatch) {
          const portNum = parseInt(portMatch[1], 10);
          if (!Number.isNaN(portNum) && portNum > 0 && portNum <= 65535) {
            port = portNum;
          }
        }
        elizaLogger.warn('Failed to parse port from response, using default 3000');
      }

      const url = await tunnelService.startTunnel(port);

      const responseText = `✅ Ngrok tunnel started successfully!\n\n🌐 Public URL: ${url}\n🔌 Local Port: ${port}\n\nYour local service is now accessible from the internet.`;

      if (callback) {
        await callback({
          text: responseText,
          metadata: {
            tunnelUrl: url,
            port,
            action: 'tunnel_started',
          },
        });
      }

      return {
        text: responseText,
        values: {
          success: true,
          tunnelUrl: url,
          port,
          isActive: true,
        },
        data: {
          action: 'START_TUNNEL',
          tunnelMetadata: {
            url,
            port,
            startedAt: new Date().toISOString(),
            provider: 'ngrok',
          },
        },
      };
    } catch (error: any) {
      elizaLogger.error('Failed to start tunnel:', error);

      if (callback) {
        await callback({
          text: `❌ Failed to start ngrok tunnel: ${error.message}\n\nPlease make sure ngrok is installed and configured properly.`,
          metadata: {
            error: error.message,
            action: 'tunnel_failed',
          },
        });
      }

      return {
        text: `❌ Failed to start ngrok tunnel: ${error.message}\n\nPlease make sure ngrok is installed and configured properly.`,
        values: {
          success: false,
          error: error.message,
        },
        data: {
          action: 'START_TUNNEL',
          errorType: 'tunnel_start_failed',
          errorDetails: error.stack,
        },
      };
    }
  },
  examples: [
    [
      {
        name: '{{user}}',
        content: {
          text: 'Start an ngrok tunnel on port 8080',
        },
      },
      {
        name: '{{agent}}',
        content: {
          text: '✅ Ngrok tunnel started successfully!\n\n🌐 Public URL: https://abc123.ngrok.io\n🔌 Local Port: 8080\n\nYour local service is now accessible from the internet.',
          actions: ['START_TUNNEL'],
        },
      },
    ],
    [
      {
        name: '{{user}}',
        content: {
          text: 'Create a tunnel for my API server and then test the webhook endpoint',
        },
      },
      {
        name: '{{agent}}',
        content: {
          text: "I'll start an ngrok tunnel for your API server and then test the webhook endpoint.",
          thought:
            'User wants to expose their API server and test webhooks - I should create the tunnel first, then use the public URL for webhook testing.',
          actions: ['START_TUNNEL'],
        },
      },
      {
        name: '{{agent}}',
        content: {
          text: '✅ Ngrok tunnel started successfully!\n\n🌐 Public URL: https://xyz789.ngrok.io\n🔌 Local Port: 3000\n\nNow testing the webhook endpoint...',
          thought:
            'Tunnel is active and I have the public URL. I can now test the webhook endpoint using this external URL.',
          actions: ['TEST_WEBHOOK'],
        },
      },
    ],
    [
      {
        name: '{{user}}',
        content: {
          text: 'Start tunnel on port 4000 and share the link in our team chat',
        },
      },
      {
        name: '{{agent}}',
        content: {
          text: "I'll start the ngrok tunnel on port 4000 and then share the public URL with your team.",
          thought:
            'User wants to expose their local service and share the link - I need to start the tunnel first, then send a message with the URL.',
          actions: ['START_TUNNEL'],
        },
      },
      {
        name: '{{agent}}',
        content: {
          text: '✅ Ngrok tunnel started successfully on port 4000! Now sharing the link with your team.',
          thought:
            'Tunnel is up and running. I can now send a message to the team chat with the public URL.',
          actions: ['SEND_MESSAGE'],
        },
      },
    ],
  ] as ActionExample[][],
};

export default startTunnelAction;

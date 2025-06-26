import {
  elizaLogger,
  type Action,
  type ActionExample,
  type ActionResult,
  type HandlerCallback,
  type IAgentRuntime,
  type ITunnelService,
  type Memory,
  type State,
} from '@elizaos/core';

export const getTunnelStatusAction: Action = {
  name: 'GET_TUNNEL_STATUS',
  similes: ['TUNNEL_STATUS', 'CHECK_TUNNEL', 'NGROK_STATUS', 'TUNNEL_INFO'],
  description:
    'Get the current status of the ngrok tunnel including URL, port, and uptime information. Supports action chaining by providing tunnel metadata for monitoring workflows, health checks, or conditional tunnel management.',
  validate: async (runtime: IAgentRuntime, _message: Memory) => {
    const tunnelService = runtime.getService<ITunnelService>('tunnel');
    return !!tunnelService;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: any,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    try {
      elizaLogger.info('Getting ngrok tunnel status...');

      const tunnelService = runtime.getService<ITunnelService>('tunnel');
      if (!tunnelService) {
        throw new Error('Tunnel service not found');
      }

      const status = tunnelService.getStatus();

      let responseText: string;
      const response = {
        ...status,
        uptime: 'N/A',
      };

      if (status.active) {
        if (status.startedAt) {
          const uptimeMs = Date.now() - new Date(status.startedAt).getTime();
          const minutes = Math.floor(uptimeMs / 60000);
          const hours = Math.floor(minutes / 60);

          if (hours > 0) {
            response.uptime = `${hours} hour${hours > 1 ? 's' : ''}, ${minutes % 60} minute${
              minutes % 60 !== 1 ? 's' : ''
            }`;
          } else {
            response.uptime = `${minutes} minute${minutes !== 1 ? 's' : ''}`;
          }
        }

        responseText = `✅ Ngrok tunnel is active!\n\n🌐 Public URL: ${status.url}\n🔌 Local Port: ${status.port}\n⏱️ Uptime: ${response.uptime}\n🏢 Provider: ${status.provider}\n\nYour local service is accessible from the internet.`;
      } else {
        responseText =
          '❌ No active ngrok tunnel.\n\nTo start a tunnel, say "start ngrok tunnel on port [PORT]"';
      }

      if (callback) {
        await callback({
          text: responseText,
          metadata: {
            ...response,
            action: 'tunnel_status',
          },
        });
      }

      return {
        text: responseText,
        values: {
          success: true,
          isActive: status.active,
          tunnelUrl: status.url,
          port: status.port,
          uptime: response.uptime,
          provider: status.provider,
        },
        data: {
          action: 'GET_TUNNEL_STATUS',
          tunnelStatus: {
            ...status,
            uptime: response.uptime,
            checkedAt: new Date().toISOString(),
          },
        },
      };
    } catch (error: any) {
      elizaLogger.error('Failed to get tunnel status:', error);

      if (callback) {
        await callback({
          text: `❌ Failed to get tunnel status: ${error.message}`,
          metadata: {
            error: error.message,
            action: 'tunnel_status_failed',
          },
        });
      }

      return {
        text: `❌ Failed to get tunnel status: ${error.message}`,
        values: {
          success: false,
          error: error.message,
        },
        data: {
          action: 'GET_TUNNEL_STATUS',
          errorType: 'status_check_failed',
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
          text: 'What is the tunnel status?',
        },
      },
      {
        name: '{{agent}}',
        content: {
          text: '✅ Ngrok tunnel is active!\n\n🌐 Public URL: https://abc123.ngrok.io\n🔌 Local Port: 3000\n⏱️ Uptime: 15 minutes\n🏢 Provider: ngrok\n\nYour local service is accessible from the internet.',
          actions: ['GET_TUNNEL_STATUS'],
        },
      },
    ],
    [
      {
        name: '{{user}}',
        content: {
          text: "Check tunnel status and restart it if it's been running too long",
        },
      },
      {
        name: '{{agent}}',
        content: {
          text: "I'll check the current tunnel status and restart it if needed.",
          thought:
            'User wants me to monitor tunnel uptime and restart if necessary - I should check status first, then decide whether to restart based on uptime.',
          actions: ['GET_TUNNEL_STATUS'],
        },
      },
      {
        name: '{{agent}}',
        content: {
          text: "Tunnel has been running for 2 hours. That seems like a long time - I'll restart it for optimal performance.",
          thought:
            'Status shows the tunnel has been up for 2 hours, which is quite long. I should stop and restart it as requested.',
          actions: ['STOP_TUNNEL'],
        },
      },
      {
        name: '{{agent}}',
        content: {
          text: 'Tunnel stopped. Now starting a fresh tunnel...',
          thought:
            'Old tunnel is down, now I can start a new fresh tunnel for optimal performance.',
          actions: ['START_TUNNEL'],
        },
      },
    ],
    [
      {
        name: '{{user}}',
        content: {
          text: 'Get tunnel info and then update our webhook URLs',
        },
      },
      {
        name: '{{agent}}',
        content: {
          text: "I'll check the current tunnel status and then update the webhook URLs.",
          thought:
            'User needs the current tunnel URL for webhook configuration - I should get the status first, then update webhooks with the public URL.',
          actions: ['GET_TUNNEL_STATUS'],
        },
      },
      {
        name: '{{agent}}',
        content: {
          text: 'Tunnel is active at https://abc123.ngrok.io. Now updating webhook URLs...',
          thought:
            'I have the current tunnel URL from the status check. I can now update the webhook configurations with this public URL.',
          actions: ['UPDATE_WEBHOOKS'],
        },
      },
    ],
  ] as ActionExample[][],
};

export default getTunnelStatusAction;

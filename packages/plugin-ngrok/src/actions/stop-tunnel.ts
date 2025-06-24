import type { ITunnelService } from '@elizaos/core';
import {
  type Action,
  type ActionExample,
  type ActionResult,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
  elizaLogger,
} from '@elizaos/core';

export const stopTunnelAction: Action = {
  name: 'STOP_TUNNEL',
  similes: ['CLOSE_TUNNEL', 'SHUTDOWN_TUNNEL', 'NGROK_STOP', 'TUNNEL_DOWN'],
  description: 'Stop the running ngrok tunnel and clean up resources. Can be chained with START_TUNNEL actions for tunnel rotation workflows or combined with deployment actions for automated service management.',
  validate: async (runtime: IAgentRuntime, _message: Memory) => {
    const tunnelService = runtime.getService('tunnel') as ITunnelService;
    return !!tunnelService;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: any,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const tunnelService = runtime.getService('tunnel') as ITunnelService;
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
        data: { action: 'STOP_TUNNEL' }
      };
    }

    if (!tunnelService.isActive()) {
      elizaLogger.warn('No active tunnel to stop');
      if (callback) {
        await callback({
          text: 'No tunnel is currently running.',
          metadata: {
            action: 'tunnel_not_active',
          },
        });
      }
      return {
        text: 'No tunnel is currently running.',
        values: { success: true, wasActive: false },
        data: { action: 'STOP_TUNNEL', status: 'already_stopped' }
      };
    }

    elizaLogger.info('Stopping ngrok tunnel...');

    try {
      const status = tunnelService.getStatus();
      const previousUrl = status.url;
      const previousPort = status.port;

      await tunnelService.stopTunnel();

      const responseText = `✅ Ngrok tunnel stopped successfully!\n\n🔌 Was running on port: ${previousPort}\n🌐 Previous URL: ${previousUrl}\n\nThe tunnel has been closed and is no longer accessible.`;

      if (callback) {
        await callback({
          text: responseText,
          metadata: {
            previousUrl,
            previousPort,
            action: 'tunnel_stopped',
          },
        });
      }

      return {
        text: responseText,
        values: {
          success: true,
          wasActive: true,
          previousUrl,
          previousPort
        },
        data: {
          action: 'STOP_TUNNEL',
          previousTunnelMetadata: {
            url: previousUrl,
            port: previousPort,
            stoppedAt: new Date().toISOString()
          }
        }
      };
    } catch (error: any) {
      elizaLogger.error('Failed to stop tunnel:', error);

      if (callback) {
        await callback({
          text: `❌ Failed to stop ngrok tunnel: ${error.message}`,
          metadata: {
            error: error.message,
            action: 'tunnel_stop_failed',
          },
        });
      }

      return {
        text: `❌ Failed to stop ngrok tunnel: ${error.message}`,
        values: {
          success: false,
          error: error.message
        },
        data: {
          action: 'STOP_TUNNEL',
          errorType: 'tunnel_stop_failed',
          errorDetails: error.stack
        }
      };
    }
  },
  examples: [
    [
      {
        name: '{{user}}',
        content: {
          text: 'Stop the ngrok tunnel',
        },
      },
      {
        name: '{{agent}}',
        content: {
          text: '✅ Ngrok tunnel stopped successfully!\n\n🔌 Was running on port: 3000\n🌐 Previous URL: https://abc123.ngrok.io\n\nThe tunnel has been closed and is no longer accessible.',
          actions: ['STOP_TUNNEL'],
        },
      },
    ],
    [
      {
        name: '{{user}}',
        content: {
          text: 'Stop the current tunnel and start a new one on port 8080',
        },
      },
      {
        name: '{{agent}}',
        content: {
          text: 'I\'ll stop the current tunnel and then start a new one on port 8080.',
          thought: 'User wants to switch tunnels - I need to stop the current one first, then start a new tunnel on the specified port.',
          actions: ['STOP_TUNNEL'],
        },
      },
      {
        name: '{{agent}}',
        content: {
          text: '✅ Tunnel stopped successfully! Now starting new tunnel on port 8080...',
          thought: 'Current tunnel is closed. Now I can start the new tunnel on port 8080 as requested.',
          actions: ['START_TUNNEL'],
        },
      },
    ],
    [
      {
        name: '{{user}}',
        content: {
          text: 'Close the tunnel and deploy to production',
        },
      },
      {
        name: '{{agent}}',
        content: {
          text: 'I\'ll stop the development tunnel and then proceed with the production deployment.',
          thought: 'User is ready to move from development to production - I should close the ngrok tunnel first, then handle the deployment process.',
          actions: ['STOP_TUNNEL'],
        },
      },
      {
        name: '{{agent}}',
        content: {
          text: 'Development tunnel closed successfully. Now initiating production deployment...',
          thought: 'Tunnel is down, development phase is complete. I can now proceed with the production deployment workflow.',
          actions: ['DEPLOY_PRODUCTION'],
        },
      },
    ],
  ] as ActionExample[][],
};

export default stopTunnelAction;

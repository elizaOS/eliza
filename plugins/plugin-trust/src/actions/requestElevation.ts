import {
  type Action,
  type IAgentRuntime,
  type Memory,
  type UUID,
  logger,
  type ActionExample,
  parseJSONObjectFromText,
} from '@elizaos/core';
import type { ElevationRequest } from '../types/permissions';

export const requestElevationAction: Action = {
  name: 'REQUEST_ELEVATION',
  description: 'Request temporary elevation of permissions for a specific action',

  validate: async (runtime: IAgentRuntime, _message: Memory) => {
    const permissionSystem = runtime.getService('contextual-permissions');
    return !!permissionSystem;
  },

  handler: async (runtime: IAgentRuntime, message: Memory) => {
    const permissionSystem = runtime.getService('contextual-permissions') as any;
    const trustEngine = runtime.getService('trust-engine') as any;

    if (!permissionSystem || !trustEngine) {
      throw new Error('Required services not available');
    }

    // Parse the elevation request
    const text = message.content.text || '';
    const parsed = parseJSONObjectFromText(text);
    const requestData = parsed as {
      action?: string;
      resource?: string;
      justification?: string;
      duration?: number; // minutes
    } | null;

    if (!requestData || !requestData.action) {
      return {
        success: false,
        text: 'Please specify the action you need elevated permissions for. Example: "I need to manage roles to help moderate the channel"',
        error: 'No action specified',
      };
    }

    // Get current trust profile
    const trustProfile = await trustEngine.evaluateTrust(message.entityId, runtime.agentId, {
      roomId: message.roomId,
    });

    // Create elevation request
    const elevationRequest: ElevationRequest = {
      entityId: message.entityId,
      requestedPermission: {
        action: requestData.action,
        resource: requestData.resource || '*',
      },
      justification: requestData.justification || text,
      context: {
        roomId: message.roomId,
        platform: 'discord',
      },
      duration: (requestData.duration || 60) * 60 * 1000, // Convert minutes to ms
    };

    try {
      const result = await permissionSystem.requestElevation(elevationRequest);

      if (result.approved) {
        const expiryTime = new Date(result.expiresAt!).toLocaleString();
        return {
          success: true,
          text: `✅ Elevation approved! You have been granted temporary ${requestData.action} permissions until ${expiryTime}.

Please use these permissions responsibly. All actions will be logged for audit.`,
          data: {
            approved: true,
            elevationId: result.elevationId,
            expiresAt: result.expiresAt,
            permissions: result.grantedPermissions,
          },
        };
      } else {
        // Provide helpful feedback on denial
        let denialMessage = `❌ Elevation request denied: ${result.reason}`;

        if (result.trustDeficit && result.trustDeficit > 0) {
          denialMessage += `\n\nYour current trust score is ${trustProfile.overallTrust}/100. You need ${Math.ceil(result.trustDeficit)} more trust points for this permission.`;
        }

        if (result.suggestions && result.suggestions.length > 0) {
          denialMessage +=
            '\n\nSuggestions:\n' + result.suggestions.map((s) => `• ${s}`).join('\n');
        }

        return {
          success: false,
          text: denialMessage,
          data: {
            approved: false,
            reason: result.reason,
            currentTrust: trustProfile.overallTrust,
            requiredTrust: result.requiredTrust,
          },
        };
      }
    } catch (error) {
      logger.error({ error }, '[RequestElevation] Error processing elevation request:');
      return {
        success: false,
        text: 'Failed to process elevation request. Please try again.',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  },

  examples: [
    [
      {
        name: '{{name1}}',
        content: {
          text: 'I need permission to manage roles to help moderate spam in the channel',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: '✅ Elevation approved! You have been granted temporary manage_roles permissions until 12/20/2024, 5:30:00 PM.\n\nPlease use these permissions responsibly. All actions will be logged for audit.',
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: 'Grant me admin access',
        },
      },
      {
        name: '{{name2}}',
        content: {
          text: '❌ Elevation request denied: Insufficient justification provided\n\nYour current trust score is 45/100. You need 15 more trust points for this permission.\n\nSuggestions:\n• Provide a specific justification for why you need admin access\n• Build trust through consistent positive contributions\n• Request more specific permissions instead of full admin access',
        },
      },
    ],
  ],

  similes: [
    'request elevated permissions',
    'need temporary access',
    'request higher privileges',
    'need admin permission',
    'elevate my permissions',
    'grant me access',
    'temporary permission request',
    'need special access',
  ],
};

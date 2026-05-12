/**
 * @module tunnel
 * @description Single dispatcher action that fans out to the active
 * tunnel-service implementation. The action's name is `TUNNEL`; concrete
 * providers such as local Tailscale, Eliza Cloud headscale, and ngrok only
 * register the service backend.
 *
 * Sub-ops (selected via the `action` parameter-enum):
 *   - start  -> handleStartTunnel    (optional `port`, defaults to 3000)
 *   - stop   -> handleStopTunnel     (no parameters)
 *   - status -> handleGetTunnelStatus (no parameters)
 *
 * The handler accepts both call shapes:
 *   1. `{ action, ...subParams }`
 *   2. `{ parameters: { action, parameters: { ...subParams } } }` (LLM extraction)
 */

import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from '@elizaos/core';
import { getTunnelService } from '../types';
import { handleGetTunnelStatus } from './get-tunnel-status';
import { handleStartTunnel } from './start-tunnel';
import { handleStopTunnel } from './stop-tunnel';

const SUPPORTED_OPS = ['start', 'stop', 'status'] as const;

function pickRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function resolveDispatch(options: Record<string, unknown> | undefined): {
  action: string | null;
  subOptions: Record<string, unknown>;
} {
  if (!options) {
    return { action: null, subOptions: {} };
  }
  const nested = pickRecord(options.parameters);
  const actionSource = nested ?? options;
  const rawAction = actionSource.action;
  const action = typeof rawAction === 'string' ? rawAction.toLowerCase() : null;

  let subOptions: Record<string, unknown>;
  if (nested) {
    const innerParams = pickRecord(nested.parameters);
    if (innerParams) {
      subOptions = { ...innerParams };
    } else {
      const { action: _omitAction, parameters: _omitParams, ...rest } = nested;
      subOptions = rest;
    }
  } else {
    const { action: _omitAction, ...rest } = options;
    subOptions = rest;
  }

  return { action, subOptions };
}

export const tunnelAction: Action = {
  name: 'TUNNEL',
  similes: ['OPEN_TUNNEL', 'CREATE_TUNNEL', 'CLOSE_TUNNEL', 'CHECK_TUNNEL', 'TUNNEL_INFO'],
  description:
    'Tunnel operations dispatched by `action`: start, stop, status. The `start` action accepts an optional `port` (defaults to 3000); `stop` and `status` take no parameters. Backed by whichever tunnel plugin is active (local Tailscale CLI, Eliza Cloud headscale, or ngrok).',

  parameters: [
    {
      name: 'action',
      description: 'Which tunnel sub-operation to run. One of: start, stop, status.',
      required: true,
      schema: {
        type: 'string',
        enum: [...SUPPORTED_OPS],
      },
    },
    {
      name: 'parameters',
      description:
        'Parameters forwarded to the selected sub-op. For `start`, optionally `{ port: number }`. `stop` and `status` take no parameters.',
      required: false,
      schema: { type: 'object' },
    },
  ],

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    return Boolean(getTunnelService(runtime));
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const { action, subOptions } = resolveDispatch(options);

    if (!action) {
      const err = `TUNNEL requires action=start|stop|status`;
      if (callback) await callback({ text: err });
      return { success: false, error: err };
    }

    switch (action) {
      case 'start':
        return handleStartTunnel(runtime, message, state, subOptions, callback);
      case 'stop':
        return handleStopTunnel(runtime, message, state, subOptions, callback);
      case 'status':
        return handleGetTunnelStatus(runtime, message, state, subOptions, callback);
      default: {
        const err = `Unknown TUNNEL action "${action}". Supported: ${SUPPORTED_OPS.join(', ')}`;
        if (callback) await callback({ text: err });
        return { success: false, error: err };
      }
    }
  },

  examples: [
    [
      {
        name: '{{user1}}',
        content: { text: 'Start a tunnel on port 8080' },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'Tunnel started (tailscale).\n\nURL: https://device.tail-scale.ts.net\nLocal port: 8080',
          actions: ['TUNNEL'],
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: { text: 'Stop the tunnel' },
      },
      {
        name: '{{agentName}}',
        content: {
          text: 'Tunnel stopped.',
          actions: ['TUNNEL'],
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: { text: 'What is the tunnel status?' },
      },
      {
        name: '{{agentName}}',
        content: {
          text: '✅ tunnel active (tailscale).',
          actions: ['TUNNEL'],
        },
      },
    ],
  ],
};

export default tunnelAction;

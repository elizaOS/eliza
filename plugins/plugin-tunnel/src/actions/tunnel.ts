/**
 * @module tunnel
 * @description Single dispatcher action that fans out to the active
 * tunnel-service implementation. The action's name is `TUNNEL`; legacy
 * `TAILSCALE`-prefixed action names are kept as `similes` so older
 * characters and callers still resolve.
 *
 * Sub-ops (selected via the `op` parameter-enum):
 *   - start  -> handleStartTunnel    (optional `port`, defaults to 3000)
 *   - stop   -> handleStopTunnel     (no parameters)
 *   - status -> handleGetTunnelStatus (no parameters)
 *
 * The handler accepts both call shapes:
 *   1. `{ op, ...subParams }`
 *   2. `{ parameters: { op, parameters: { ...subParams } } }` (LLM extraction)
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
  op: string | null;
  subOptions: Record<string, unknown>;
} {
  if (!options) {
    return { op: null, subOptions: {} };
  }
  const nested = pickRecord(options.parameters);
  const opSource = nested ?? options;
  const rawOp = opSource.op;
  const op = typeof rawOp === 'string' ? rawOp.toLowerCase() : null;

  let subOptions: Record<string, unknown>;
  if (nested) {
    const innerParams = pickRecord(nested.parameters);
    if (innerParams) {
      subOptions = { ...innerParams };
    } else {
      const { op: _omitOp, parameters: _omitParams, ...rest } = nested;
      subOptions = rest;
    }
  } else {
    const { op: _omitOp, ...rest } = options;
    subOptions = rest;
  }

  return { op, subOptions };
}

export const tunnelAction: Action = {
  name: 'TUNNEL',
  similes: [
    // Legacy action names kept so existing characters/transcripts still resolve.
    'TAILSCALE',
    'START_TAILSCALE',
    'STOP_TAILSCALE',
    'GET_TAILSCALE_STATUS',
    'START_TUNNEL',
    'OPEN_TUNNEL',
    'CREATE_TUNNEL',
    'TAILSCALE_UP',
    'STOP_TUNNEL',
    'CLOSE_TUNNEL',
    'TAILSCALE_DOWN',
    'TAILSCALE_STATUS',
    'CHECK_TUNNEL',
    'TUNNEL_INFO',
    'TUNNEL_STATUS',
  ],
  description:
    'Tunnel operations dispatched by `op`: start, stop, status. The `start` op accepts an optional `port` (defaults to 3000); `stop` and `status` take no parameters. Backed by whichever tunnel plugin is active (local Tailscale CLI, Eliza Cloud headscale, or ngrok).',

  parameters: [
    {
      name: 'op',
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
    const { op, subOptions } = resolveDispatch(options);

    if (!op) {
      const err = `TUNNEL action requires \`op\` (one of: ${SUPPORTED_OPS.join(', ')})`;
      if (callback) await callback({ text: err });
      return { success: false, error: err };
    }

    switch (op) {
      case 'start':
        return handleStartTunnel(runtime, message, state, subOptions, callback);
      case 'stop':
        return handleStopTunnel(runtime, message, state, subOptions, callback);
      case 'status':
        return handleGetTunnelStatus(runtime, message, state, subOptions, callback);
      default: {
        const err = `Unknown TUNNEL op "${op}". Supported: ${SUPPORTED_OPS.join(', ')}`;
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

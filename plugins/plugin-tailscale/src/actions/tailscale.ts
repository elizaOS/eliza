/**
 * TAILSCALE router action.
 *
 * Single entry point for tunnel lifecycle: start, stop. Replaces the prior
 * START_TAILSCALE and STOP_TAILSCALE actions. Status reads were demoted to
 * the `tailscaleStatus` provider (TOON-rendered, available every turn).
 *
 * Operation is selected from `parameters.op`. The TOON-in-prompt extraction
 * for the optional `port` argument on `start` is preserved.
 */

import {
  ModelType,
  elizaLogger,
  type Action,
  type ActionResult,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  parseToonKeyValue,
} from '@elizaos/core';
import { z } from 'zod';
import { getTunnelService } from '../types';

type TailscaleOp = 'start' | 'stop';

const ALL_OPS: readonly TailscaleOp[] = ['start', 'stop'] as const;

const portPayloadSchema = z.object({
  port: z.union([z.number(), z.string().regex(/^\d+$/)]).transform((value) => {
    const num = typeof value === 'string' ? Number.parseInt(value, 10) : value;
    return num;
  }),
});

const PORT_PROMPT_TEMPLATE = `Extract the port number to start the tunnel on.
The user said: "{{userMessage}}"

Extract the port number from their message, or use the default port 3000 if not specified.

Respond with TOON only:
port: 3000`;

const DEFAULT_PORT = 3000;

function isValidPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

function parsePort(value: string): number {
  const toonParsed = parseToonKeyValue<Record<string, unknown>>(value);
  const toonResult = portPayloadSchema.safeParse(toonParsed);
  if (toonResult.success && isValidPort(toonResult.data.port)) return toonResult.data.port;

  try {
    const parsed: unknown = JSON.parse(value);
    const result = portPayloadSchema.safeParse(parsed);
    if (result.success && isValidPort(result.data.port)) return result.data.port;
  } catch {
    // fall through
  }
  const match = value.match(/\b(\d{1,5})\b/);
  const captured = match?.[1];
  if (!captured) return DEFAULT_PORT;
  const num = Number.parseInt(captured, 10);
  return isValidPort(num) ? num : DEFAULT_PORT;
}

function readOp(options: unknown): TailscaleOp | null {
  const direct = options && typeof options === 'object' ? (options as Record<string, unknown>) : {};
  const params =
    direct.parameters && typeof direct.parameters === 'object'
      ? (direct.parameters as Record<string, unknown>)
      : {};
  const requested = params.op ?? direct.op;
  if (typeof requested === 'string') {
    const normalized = requested.trim().toLowerCase();
    if ((ALL_OPS as readonly string[]).includes(normalized)) {
      return normalized as TailscaleOp;
    }
  }
  return null;
}

async function handleStart(
  runtime: IAgentRuntime,
  message: Memory,
  callback?: HandlerCallback,
): Promise<ActionResult> {
  const tunnelService = getTunnelService(runtime);
  if (!tunnelService) {
    if (callback) {
      await callback({
        text: 'Tunnel service is not available. Ensure the tailscale plugin is properly configured.',
      });
    }
    return { success: false, error: 'tunnel service unavailable' };
  }

  if (tunnelService.isActive()) {
    if (callback) {
      await callback({
        text: 'Tunnel is already active. Stop the existing tunnel before starting a new one.',
      });
    }
    return { success: false, error: 'tunnel already active' };
  }

  elizaLogger.info('[tailscale] starting tunnel');

  const userMessage = message.content.text ?? '';
  const portResponse = await runtime.useModel(ModelType.TEXT_SMALL, {
    prompt: PORT_PROMPT_TEMPLATE.replace('{{userMessage}}', userMessage),
    temperature: 0.3,
  });

  const port = parsePort(String(portResponse));
  const url = await tunnelService.startTunnel(port);
  const publicUrl = typeof url === 'string' ? url : tunnelService.getUrl();

  if (callback) {
    await callback({
      text: `Tailscale tunnel started.\n\nURL: ${publicUrl ?? 'unknown'}\nLocal port: ${port}`,
    });
  }

  return {
    success: true,
    text: `Tailscale tunnel started on port ${port}`,
    data: {
      action: 'tunnel_started',
      tunnelUrl: publicUrl ?? '',
      port,
    },
  };
}

async function handleStop(
  runtime: IAgentRuntime,
  callback?: HandlerCallback,
): Promise<ActionResult> {
  const tunnelService = getTunnelService(runtime);
  if (!tunnelService) {
    if (callback) {
      await callback({ text: 'Tunnel service is not available.' });
    }
    return { success: false, error: 'tunnel service unavailable' };
  }

  if (!tunnelService.isActive()) {
    elizaLogger.warn('[tailscale] no active tunnel to stop');
    if (callback) {
      await callback({ text: 'No tunnel is currently running.' });
    }
    return {
      success: true,
      text: 'no active tunnel',
      data: { action: 'tunnel_not_active' },
    };
  }

  const status = tunnelService.getStatus();
  const previousUrl = status.url;
  const previousPort = status.port;

  await tunnelService.stopTunnel();

  if (callback) {
    await callback({
      text: `Tailscale tunnel stopped.\n\nWas running on port: ${previousPort}\nPrevious URL: ${previousUrl}`,
    });
  }
  return {
    success: true,
    text: `Tailscale tunnel stopped (was on port ${previousPort})`,
    data: {
      action: 'tunnel_stopped',
      previousUrl: previousUrl ?? '',
      previousPort: previousPort ?? 0,
    },
  };
}

export const tailscaleAction: Action = {
  name: 'TAILSCALE',
  similes: [
    'TAILSCALE_OP',
    'START_TAILSCALE',
    'STOP_TAILSCALE',
    'START_TUNNEL',
    'STOP_TUNNEL',
    'OPEN_TUNNEL',
    'CLOSE_TUNNEL',
    'CREATE_TUNNEL',
    'TAILSCALE_UP',
    'TAILSCALE_DOWN',
  ],
  description:
    'Tailscale tunnel router. Operations: start (open tunnel for a local port), stop (close active tunnel). Status reads come from the tailscaleStatus provider.',
  descriptionCompressed: 'Tailscale: start tunnel, stop tunnel.',
  parameters: [
    {
      name: 'op',
      description: 'Tunnel operation. One of: start, stop.',
      required: true,
      schema: { type: 'string', enum: [...ALL_OPS] },
    },
  ],
  validate: async (runtime: IAgentRuntime) => Boolean(getTunnelService(runtime)),
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state,
    options,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const op = readOp(options);
    if (op === null) {
      const text = 'TAILSCALE requires op: start or stop.';
      if (callback) {
        await callback({ text });
      }
      return { success: false, text, error: 'missing op' };
    }

    switch (op) {
      case 'start':
        return handleStart(runtime, message, callback);
      case 'stop':
        return handleStop(runtime, callback);
    }
  },
  examples: [
    [
      {
        name: 'user',
        content: { text: 'Start a tailscale tunnel on port 8080' },
      },
      {
        name: 'assistant',
        content: {
          text: 'Tailscale tunnel started.\n\nURL: https://device.tail-scale.ts.net\nLocal port: 8080',
          actions: ['TAILSCALE'],
        },
      },
    ],
    [
      { name: 'user', content: { text: 'Stop the tailscale tunnel' } },
      {
        name: 'assistant',
        content: {
          text: 'Tailscale tunnel stopped.\n\nWas running on port: 3000\nPrevious URL: https://device.tail-scale.ts.net',
          actions: ['TAILSCALE'],
        },
      },
    ],
  ],
};

export default tailscaleAction;

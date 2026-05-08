/**
 * TAILSCALE router action.
 *
 * Single entry point for tunnel lifecycle: start, stop. Replaces the prior
 * START_TAILSCALE and STOP_TAILSCALE actions. Status reads were demoted to
 * the `tailscaleStatus` provider (JSON-rendered, available every turn).
 *
 * Operation is selected from `parameters.op`. Optional `parameters.port` is
 * preferred for start; JSON extraction from the message is the fallback.
 */

import {
  ModelType,
  elizaLogger,
  type Action,
  type ActionResult,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  type Memory,
} from '@elizaos/core';
import { z } from 'zod';
import { resolveTailscaleAccountId } from '../accounts';
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

Respond with JSON only:
{"port":3000}`;

const DEFAULT_PORT = 3000;

function isValidPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parsePort(value: string): number {
  const parsed = parseJsonObject(value.trim());
  const result = portPayloadSchema.safeParse(parsed);
  return result.success && isValidPort(result.data.port) ? result.data.port : DEFAULT_PORT;
}

function readPort(options?: HandlerOptions): number | null {
  const direct = options && typeof options === 'object' ? (options as Record<string, unknown>) : {};
  const params =
    direct.parameters && typeof direct.parameters === 'object'
      ? (direct.parameters as Record<string, unknown>)
      : {};
  const result = portPayloadSchema.safeParse({ port: params.port ?? direct.port });
  return result.success && isValidPort(result.data.port) ? result.data.port : null;
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

function readOptions(options?: HandlerOptions): Record<string, unknown> {
  const direct = options && typeof options === 'object' ? (options as Record<string, unknown>) : {};
  const params =
    direct.parameters && typeof direct.parameters === 'object'
      ? (direct.parameters as Record<string, unknown>)
      : {};
  return { ...direct, ...params };
}

async function handleStart(
  runtime: IAgentRuntime,
  message: Memory,
  options?: HandlerOptions,
  callback?: HandlerCallback,
): Promise<ActionResult> {
  const tunnelService = getTunnelService(runtime);
  const accountId = resolveTailscaleAccountId(runtime, readOptions(options));
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
  const directPort = readPort(options);
  const port =
    directPort ??
    parsePort(
      String(
        await runtime.useModel(ModelType.TEXT_SMALL, {
          prompt: PORT_PROMPT_TEMPLATE.replace('{{userMessage}}', userMessage),
          temperature: 0.3,
        }),
      ),
    );
  const url = await tunnelService.startTunnel(port, { accountId });
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
      accountId,
    },
  };
}

async function handleStop(
  runtime: IAgentRuntime,
  options?: HandlerOptions,
  callback?: HandlerCallback,
): Promise<ActionResult> {
  const tunnelService = getTunnelService(runtime);
  const accountId = resolveTailscaleAccountId(runtime, readOptions(options));
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
      data: { action: 'tunnel_not_active', accountId },
    };
  }

  const status = tunnelService.getStatus();
  const previousUrl = status.url;
  const previousPort = status.port;

  await tunnelService.stopTunnel({ accountId });

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
      accountId,
    },
  };
}

export const tailscaleAction: Action = {
  name: 'TAILSCALE',
  contexts: ['connectors', 'settings', 'admin'],
  contextGate: { anyOf: ['connectors', 'settings', 'admin'] },
  roleGate: { minRole: 'USER' },
  similes: [],
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
    {
      name: 'port',
      description: 'Local port to expose when op is start.',
      required: false,
      schema: { type: 'number', default: DEFAULT_PORT },
    },
    {
      name: 'accountId',
      description:
        'Optional Tailscale account id from TAILSCALE_ACCOUNTS. Defaults to TAILSCALE_DEFAULT_ACCOUNT_ID or legacy settings.',
      required: false,
      schema: { type: 'string' },
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
        return handleStart(runtime, message, options, callback);
      case 'stop':
        return handleStop(runtime, options, callback);
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

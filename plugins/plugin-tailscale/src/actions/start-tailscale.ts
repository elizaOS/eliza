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

export const startTailscaleAction: Action = {
  name: 'START_TAILSCALE',
  similes: ['START_TUNNEL', 'OPEN_TUNNEL', 'CREATE_TUNNEL', 'TAILSCALE_UP'],
  description:
    'Start a Tailscale tunnel exposing a local port to your tailnet (or the public internet via Funnel)',
  descriptionCompressed:
    'start Tailscale tunnel expose local port tailnet (public internet via Funnel)',
  validate: async (runtime: IAgentRuntime) => {
    const tunnelService = getTunnelService(runtime);
    if (!tunnelService) return false;
    return !tunnelService.isActive();
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state,
    _options,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
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

    elizaLogger.info('[start-tailscale] starting tunnel');

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
          actions: ['START_TAILSCALE'],
        },
      },
    ],
  ],
};

export default startTailscaleAction;

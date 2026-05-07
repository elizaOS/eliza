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

Respond with JSON only:
{"port":3000}`;

const DEFAULT_PORT = 3000;
const TAILSCALE_MODEL_TIMEOUT_MS = 10_000;
const TAILSCALE_START_TIMEOUT_MS = 30_000;

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

export const startTailscaleAction: Action = {
  name: 'START_TAILSCALE',
  contexts: ['connectors', 'settings', 'admin'],
  contextGate: { anyOf: ['connectors', 'settings', 'admin'] },
  roleGate: { minRole: 'USER' },
  similes: ['START_TUNNEL', 'OPEN_TUNNEL', 'CREATE_TUNNEL', 'TAILSCALE_UP'],
  description:
    'Start a Tailscale tunnel exposing a local port to your tailnet (or the public internet via Funnel)',
  descriptionCompressed:
    'start Tailscale tunnel expose local port tailnet (public internet via Funnel)',
  parameters: [
    {
      name: 'port',
      description: 'Local port to expose through the Tailscale tunnel.',
      required: false,
      schema: { type: 'number', default: DEFAULT_PORT },
    },
  ],
  validate: async (runtime: IAgentRuntime) => {
    const tunnelService = getTunnelService(runtime);
    if (!tunnelService) return false;
    return !tunnelService.isActive();
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state,
    options,
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
    const directPort = readPort(options);
    const port =
      directPort ??
      parsePort(
        String(
          await Promise.race([
            runtime.useModel(ModelType.TEXT_SMALL, {
              prompt: PORT_PROMPT_TEMPLATE.replace('{{userMessage}}', userMessage),
              temperature: 0.3,
            }),
            new Promise<never>((_, reject) =>
              setTimeout(
                () => reject(new Error('Tailscale port extraction timeout')),
                TAILSCALE_MODEL_TIMEOUT_MS,
              ),
            ),
          ]),
        ),
      );
    const url = await Promise.race([
      tunnelService.startTunnel(port),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Tailscale start timeout')), TAILSCALE_START_TIMEOUT_MS),
      ),
    ]);
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

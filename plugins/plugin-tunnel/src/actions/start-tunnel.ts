import {
  type ActionResult,
  elizaLogger,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  ModelType,
  type State,
} from '@elizaos/core';
import { z } from 'zod';
import { getTunnelService } from '../types';

const portPayloadSchema = z.object({
  port: z.union([z.number(), z.string().regex(/^\d+$/)]).transform((value) => {
    const num = typeof value === 'string' ? Number.parseInt(value, 10) : value;
    return num;
  }),
});

const PORT_PROMPT_TEMPLATE = `Respond with a JSON object containing the port number to start the tunnel on.
The user said: "{{userMessage}}"

Extract the port number from their message, or use the default port 3000 if not specified.

Response format:
\`\`\`json
{ "port": 3000 }
\`\`\``;

const DEFAULT_PORT = 3000;

function isValidPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

function parsePort(value: string): number {
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

export async function handleStartTunnel(
  runtime: IAgentRuntime,
  message: Memory,
  _state?: State,
  options?: Record<string, unknown>,
  callback?: HandlerCallback
): Promise<ActionResult> {
  const tunnelService = getTunnelService(runtime);
  if (!tunnelService) {
    if (callback) {
      await callback({
        text: 'Tunnel service is not available. Configure plugin-tunnel, plugin-elizacloud, or plugin-ngrok.',
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

  elizaLogger.info('[start-tunnel] starting tunnel');

  let port: number | undefined;
  const explicitPort = options?.port;
  if (typeof explicitPort === 'number' && isValidPort(explicitPort)) {
    port = explicitPort;
  } else if (typeof explicitPort === 'string' && /^\d+$/.test(explicitPort)) {
    const parsed = Number.parseInt(explicitPort, 10);
    if (isValidPort(parsed)) port = parsed;
  }

  if (port === undefined) {
    const userMessage = message.content.text ?? '';
    const portResponse = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt: PORT_PROMPT_TEMPLATE.replace('{{userMessage}}', userMessage),
      temperature: 0.3,
    });
    port = parsePort(String(portResponse));
  }

  const url = await tunnelService.startTunnel(port);
  const publicUrl = typeof url === 'string' ? url : tunnelService.getUrl();
  const status = tunnelService.getStatus();

  if (callback) {
    await callback({
      text: `Tunnel started (${status.provider}).\n\nURL: ${publicUrl ?? 'unknown'}\nLocal port: ${port}`,
    });
  }

  return {
    success: true,
    text: `Tunnel started on port ${port}`,
    data: {
      action: 'tunnel_started',
      tunnelUrl: publicUrl ?? '',
      port,
      provider: status.provider,
    },
  };
}

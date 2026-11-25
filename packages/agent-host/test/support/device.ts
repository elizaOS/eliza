// spec/agent/deviceActions/index.md, "Story: Enroll my device and revoke it"; spec/agent/deviceActions/index.md, "Story: Approve a device request once and learn exactly what happened"
import type { Memory, UUID } from "@elizaos/core";
import { request, type LocalAnswer } from "./socket-client.ts";

export const deviceKeyHex = "5f".repeat(32);

export interface DeviceAnswer {
  readonly status: number;
  readonly json: unknown;
}

export interface DeviceClient {
  readonly headers: (capabilities?: string) => Readonly<Record<string, string>>;
  readonly call: (method: "GET" | "POST", path: string, body?: unknown, capabilities?: string) => Promise<DeviceAnswer>;
  readonly host: (method: "GET" | "POST", path: string, body?: unknown) => Promise<DeviceAnswer>;
}

export function deviceClient(socket: string, token: string, agentId: string, negotiated: string): DeviceClient {
  const answered = (answer: LocalAnswer | { readonly refused: string }): DeviceAnswer => {
    if (!("status" in answer)) throw new Error(answer.refused);
    return { status: answer.status, json: answer.json };
  };
  const headers = (capabilities = negotiated) => ({
    "x-eliza-device-id": agentId, "x-eliza-device-key": deviceKeyHex, "x-eliza-device-capabilities": capabilities,
  });
  return {
    headers,
    call: async (method, path, body, capabilities) =>
      answered(await request(socket, { method, path, token, headers: headers(capabilities), ...(body === undefined ? {} : { body }) })),
    host: async (method, path, body) => answered(await request(socket, { method, path, token, ...(body === undefined ? {} : { body }) })),
  };
}

export interface Conversation {
  readonly id: string;
  readonly roomId: UUID;
}

export async function openConversation(client: DeviceClient): Promise<Conversation> {
  return ((await client.host("POST", "/api/conversations", {})).json as { conversation: Conversation }).conversation;
}

export async function ask(client: DeviceClient, memories: (roomId: UUID) => Promise<readonly Memory[]>, agentId: string, conversation: Conversation, text: string): Promise<Memory> {
  const sent = await client.host("POST", `/api/conversations/${conversation.id}/messages`, { text });
  if (sent.status !== 200) throw new Error(`The turn answered ${sent.status}`);
  const asked = (await memories(conversation.roomId)).find((memory) => memory.entityId !== agentId && memory.content.text === text);
  if (asked === undefined) throw new Error("The owner message was not stored");
  return asked;
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | { [key: string]: JsonValue }
  | JsonValue[];

export type JsonObject = { [key: string]: JsonValue };

export type MinecraftBridgeRequestType =
  | "health"
  | "createBot"
  | "destroyBot"
  | "chat"
  | "control"
  | "look"
  | "goto"
  | "stop"
  | "dig"
  | "place"
  | "equip"
  | "useItem"
  | "attack"
  | "getState"
  | "getInventory"
  | "scan";

export interface MinecraftBridgeRequest {
  type: MinecraftBridgeRequestType;
  requestId: string;
  botId?: string;
  data?: JsonObject;
}

export interface MinecraftBridgeResponse {
  type: string;
  requestId: string;
  success: boolean;
  data?: JsonObject;
  error?: string;
}

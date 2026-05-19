// Placeholder websocket bridge client. The real implementation (W4.1) will
// open a `ws` connection to `MILADY_AINEX_BRIDGE_URL`, parse
// CommandEnvelope/ResponseEnvelope/EventEnvelope frames, handle
// auto-reconnect, and dispatch deadman pings on the configured interval.

import type {
  BridgeCommand,
  BridgeEvent,
  EventEnvelope,
  JsonDict,
  ResponseEnvelope,
} from "./types";

export interface AinexBridgeClientOptions {
  url: string;
  autoReconnect?: boolean;
  deadmanIntervalMs?: number;
}

export interface SendOptions {
  preempt?: boolean;
}

export type BridgeEventHandler = (envelope: EventEnvelope) => void;

export class AinexBridgeClient {
  readonly url: string;
  readonly autoReconnect: boolean;
  readonly deadmanIntervalMs: number;

  constructor(options: AinexBridgeClientOptions) {
    this.url = options.url;
    this.autoReconnect = options.autoReconnect ?? true;
    this.deadmanIntervalMs = options.deadmanIntervalMs ?? 500;
  }

  async connect(): Promise<void> {
    throw new Error("AinexBridgeClient.connect() not implemented yet");
  }

  async disconnect(): Promise<void> {
    throw new Error("AinexBridgeClient.disconnect() not implemented yet");
  }

  async send(
    _command: BridgeCommand,
    _payload: JsonDict,
    _options: SendOptions = {},
  ): Promise<ResponseEnvelope> {
    throw new Error("AinexBridgeClient.send() not implemented yet");
  }

  on(_event: BridgeEvent, _handler: BridgeEventHandler): void {
    throw new Error("AinexBridgeClient.on() not implemented yet");
  }
}

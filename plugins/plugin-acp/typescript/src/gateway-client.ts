import type { EventFrame, GatewayClientStub } from "./types.js";

export type GatewayClientOptions = {
  url: string;
  token?: string;
  password?: string;
  clientName?: string;
  clientDisplayName?: string;
  clientVersion?: string;
  mode?: string;
  onEvent?: (evt: EventFrame) => void;
  onHelloOk?: () => void;
  onClose?: (code: number, reason: string) => void;
};

/**
 * Stub GatewayClient - gateway functionality moved to plugins
 * This can be extended by specific gateway implementations
 */
export class GatewayClient implements GatewayClientStub {
  private url: string;
  private _onEvent?: (evt: EventFrame) => void;
  private _onHelloOk?: () => void;
  private _onClose?: (code: number, reason: string) => void;

  constructor(opts: GatewayClientOptions) {
    this.url = opts.url;
    this._onEvent = opts.onEvent;
    this._onHelloOk = opts.onHelloOk;
    this._onClose = opts.onClose;
  }

  /**
   * Start the gateway connection
   */
  start(): void {
    // Gateway functionality moved to plugins
    // This is a stub that will fail gracefully
    setTimeout(() => {
      this._onClose?.(1000, "Gateway functionality moved to plugins");
    }, 100);
  }

  /**
   * Make a request to the gateway
   */
  async request<T>(_method: string, _params?: unknown): Promise<T> {
    throw new Error(
      "Gateway functionality moved to plugins - use plugin-based gateway",
    );
  }

  /**
   * Get the gateway URL
   */
  getUrl(): string {
    return this.url;
  }
}

/**
 * Create a gateway client from configuration
 */
export function createGatewayClient(opts: GatewayClientOptions): GatewayClient {
  return new GatewayClient(opts);
}

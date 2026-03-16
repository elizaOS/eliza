import { Readable } from "node:stream";

/**
 * Logger interface for the SSE client
 */
export interface TlonClientLogger {
  log?: (message: string) => void;
  error?: (message: string) => void;
}

/**
 * Options for creating a TlonClient
 */
export interface TlonClientOptions {
  /** Ship name (without ~) */
  ship?: string;
  /** Callback when reconnection occurs */
  onReconnect?: (client: TlonClient) => Promise<void> | void;
  /** Enable auto-reconnection (default: true) */
  autoReconnect?: boolean;
  /** Max reconnection attempts (default: 10) */
  maxReconnectAttempts?: number;
  /** Initial reconnect delay in ms (default: 1000) */
  reconnectDelay?: number;
  /** Maximum reconnect delay in ms (default: 30000) */
  maxReconnectDelay?: number;
  /** Logger instance */
  logger?: TlonClientLogger;
}

/**
 * Subscription parameters
 */
export interface SubscribeParams {
  app: string;
  path: string;
  event?: (data: unknown) => void;
  err?: (error: unknown) => void;
  quit?: () => void;
}

/**
 * Poke parameters
 */
export interface PokeParams {
  app: string;
  mark: string;
  json: unknown;
}

/**
 * Internal subscription representation
 */
interface Subscription {
  id: number;
  action: "subscribe";
  ship: string;
  app: string;
  path: string;
}

/**
 * Event handlers for a subscription
 */
interface EventHandlers {
  event?: (data: unknown) => void;
  err?: (error: unknown) => void;
  quit?: () => void;
}

/**
 * Authenticates with an Urbit ship and returns the session cookie
 */
export async function authenticate(url: string, code: string): Promise<string> {
  const response = await fetch(`${url}/~/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `password=${code}`,
  });

  if (!response.ok) {
    throw new Error(`Authentication failed with status ${response.status}`);
  }

  await response.text();
  const cookie = response.headers.get("set-cookie");
  if (!cookie) {
    throw new Error("No authentication cookie received");
  }
  return cookie;
}

/**
 * Tlon/Urbit HTTP API client with SSE support
 */
export class TlonClient {
  readonly url: string;
  readonly cookie: string;
  readonly ship: string;

  private channelId: string;
  private channelUrl: string;
  private subscriptions: Subscription[] = [];
  private eventHandlers = new Map<number, EventHandlers>();
  private aborted = false;

  private onReconnect: TlonClientOptions["onReconnect"] | null;
  private autoReconnect: boolean;
  private reconnectAttempts = 0;
  private maxReconnectAttempts: number;
  private reconnectDelay: number;
  private maxReconnectDelay: number;
  private _isConnected = false;
  private clientLogger: TlonClientLogger;

  constructor(url: string, cookie: string, options: TlonClientOptions = {}) {
    this.url = url;
    this.cookie = cookie.split(";")[0];
    this.ship = options.ship?.replace(/^~/, "") ?? this.resolveShipFromUrl(url);
    this.channelId = this.generateChannelId();
    this.channelUrl = `${url}/~/channel/${this.channelId}`;
    this.onReconnect = options.onReconnect ?? null;
    this.autoReconnect = options.autoReconnect !== false;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 10;
    this.reconnectDelay = options.reconnectDelay ?? 1000;
    this.maxReconnectDelay = options.maxReconnectDelay ?? 30000;
    this.clientLogger = options.logger ?? {};
  }

  /** Whether the client is currently connected */
  get isConnected(): boolean {
    return this._isConnected;
  }

  private generateChannelId(): string {
    return `${Math.floor(Date.now() / 1000)}-${Math.random().toString(36).substring(2, 8)}`;
  }

  private resolveShipFromUrl(url: string): string {
    try {
      const parsed = new URL(url);
      const host = parsed.hostname;
      if (host.includes(".")) {
        return host.split(".")[0] ?? host;
      }
      return host;
    } catch {
      return "";
    }
  }

  /**
   * Subscribe to an app's path for updates
   */
  async subscribe(params: SubscribeParams): Promise<number> {
    const subId = this.subscriptions.length + 1;
    const subscription: Subscription = {
      id: subId,
      action: "subscribe",
      ship: this.ship,
      app: params.app,
      path: params.path,
    };

    this.subscriptions.push(subscription);
    this.eventHandlers.set(subId, {
      event: params.event,
      err: params.err,
      quit: params.quit,
    });

    if (this._isConnected) {
      try {
        await this.sendSubscription(subscription);
      } catch (error) {
        const handler = this.eventHandlers.get(subId);
        handler?.err?.(error);
      }
    }
    return subId;
  }

  private async sendSubscription(subscription: Subscription): Promise<void> {
    const response = await fetch(this.channelUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Cookie: this.cookie,
      },
      body: JSON.stringify([subscription]),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok && response.status !== 204) {
      const errorText = await response.text();
      throw new Error(`Subscribe failed: ${response.status} - ${errorText}`);
    }
  }

  /**
   * Connect to the Urbit ship and start receiving events
   */
  async connect(): Promise<void> {
    // Create channel with initial subscriptions
    const createResp = await fetch(this.channelUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Cookie: this.cookie,
      },
      body: JSON.stringify(this.subscriptions),
      signal: AbortSignal.timeout(30_000),
    });

    if (!createResp.ok && createResp.status !== 204) {
      throw new Error(`Channel creation failed: ${createResp.status}`);
    }

    // Activate channel with a poke
    const pokeResp = await fetch(this.channelUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Cookie: this.cookie,
      },
      body: JSON.stringify([
        {
          id: Date.now(),
          action: "poke",
          ship: this.ship,
          app: "hood",
          mark: "helm-hi",
          json: "Opening API channel",
        },
      ]),
      signal: AbortSignal.timeout(30_000),
    });

    if (!pokeResp.ok && pokeResp.status !== 204) {
      throw new Error(`Channel activation failed: ${pokeResp.status}`);
    }

    await this.openStream();
    this._isConnected = true;
    this.reconnectAttempts = 0;
  }

  private async openStream(): Promise<void> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60_000);

    const response = await fetch(this.channelUrl, {
      method: "GET",
      headers: {
        Accept: "text/event-stream",
        Cookie: this.cookie,
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Stream connection failed: ${response.status}`);
    }

    this.processStream(response.body).catch((error) => {
      if (!this.aborted) {
        this.clientLogger.error?.(`Stream error: ${String(error)}`);
        for (const { err } of this.eventHandlers.values()) {
          err?.(error);
        }
      }
    });
  }

  private async processStream(
    body: ReadableStream<Uint8Array> | NodeJS.ReadableStream | null,
  ): Promise<void> {
    if (!body) return;

    const stream =
      body instanceof ReadableStream
        ? Readable.fromWeb(body as ReadableStream)
        : body;
    let buffer = "";

    try {
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        if (this.aborted) break;

        buffer += chunk.toString();
        let eventEnd;
        while ((eventEnd = buffer.indexOf("\n\n")) !== -1) {
          const eventData = buffer.substring(0, eventEnd);
          buffer = buffer.substring(eventEnd + 2);
          this.processEvent(eventData);
        }
      }
    } finally {
      if (!this.aborted && this.autoReconnect) {
        this._isConnected = false;
        this.clientLogger.log?.(
          "[SSE] Stream ended, attempting reconnection...",
        );
        await this.attemptReconnect();
      }
    }
  }

  private processEvent(eventData: string): void {
    const lines = eventData.split("\n");
    let data: string | null = null;

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        data = line.substring(6);
      }
    }

    if (!data) return;

    try {
      const parsed = JSON.parse(data) as {
        id?: number;
        json?: unknown;
        response?: string;
      };

      if (parsed.response === "quit") {
        if (parsed.id) {
          const handlers = this.eventHandlers.get(parsed.id);
          handlers?.quit?.();
        }
        return;
      }

      if (parsed.id && this.eventHandlers.has(parsed.id)) {
        const { event } = this.eventHandlers.get(parsed.id) ?? {};
        if (event && parsed.json) {
          event(parsed.json);
        }
      } else if (parsed.json) {
        // Broadcast to all handlers if no specific ID
        for (const { event } of this.eventHandlers.values()) {
          event?.(parsed.json);
        }
      }
    } catch (error) {
      this.clientLogger.error?.(`Error parsing SSE event: ${String(error)}`);
    }
  }

  /**
   * Send a poke to an app
   */
  async poke(params: PokeParams): Promise<number> {
    const pokeId = Date.now();
    const pokeData = {
      id: pokeId,
      action: "poke",
      ship: this.ship,
      app: params.app,
      mark: params.mark,
      json: params.json,
    };

    const response = await fetch(this.channelUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Cookie: this.cookie,
      },
      body: JSON.stringify([pokeData]),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok && response.status !== 204) {
      const errorText = await response.text();
      throw new Error(`Poke failed: ${response.status} - ${errorText}`);
    }

    return pokeId;
  }

  /**
   * Perform a scry (read-only query)
   */
  async scry<T = unknown>(path: string): Promise<T> {
    const scryUrl = `${this.url}/~/scry${path}`;
    const response = await fetch(scryUrl, {
      method: "GET",
      headers: {
        Cookie: this.cookie,
      },
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      throw new Error(`Scry failed: ${response.status} for path ${path}`);
    }

    return (await response.json()) as T;
  }

  private async attemptReconnect(): Promise<void> {
    if (this.aborted || !this.autoReconnect) {
      this.clientLogger.log?.("[SSE] Reconnection aborted or disabled");
      return;
    }

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.clientLogger.error?.(
        `[SSE] Max reconnection attempts (${this.maxReconnectAttempts}) reached. Giving up.`,
      );
      return;
    }

    this.reconnectAttempts += 1;
    const delay = Math.min(
      this.reconnectDelay * 2 ** (this.reconnectAttempts - 1),
      this.maxReconnectDelay,
    );

    this.clientLogger.log?.(
      `[SSE] Reconnection attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms...`,
    );

    await new Promise((resolve) => setTimeout(resolve, delay));

    try {
      // Generate new channel ID for reconnection
      this.channelId = this.generateChannelId();
      this.channelUrl = `${this.url}/~/channel/${this.channelId}`;

      if (this.onReconnect) {
        await this.onReconnect(this);
      }

      await this.connect();
      this.clientLogger.log?.("[SSE] Reconnection successful!");
    } catch (error) {
      this.clientLogger.error?.(`[SSE] Reconnection failed: ${String(error)}`);
      await this.attemptReconnect();
    }
  }

  /**
   * Close the connection and cleanup
   */
  async close(): Promise<void> {
    this.aborted = true;
    this._isConnected = false;

    try {
      // Unsubscribe from all subscriptions
      const unsubscribes = this.subscriptions.map((sub) => ({
        id: sub.id,
        action: "unsubscribe",
        subscription: sub.id,
      }));

      await fetch(this.channelUrl, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Cookie: this.cookie,
        },
        body: JSON.stringify(unsubscribes),
        signal: AbortSignal.timeout(30_000),
      });

      // Delete the channel
      await fetch(this.channelUrl, {
        method: "DELETE",
        headers: {
          Cookie: this.cookie,
        },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      this.clientLogger.error?.(`Error closing channel: ${String(error)}`);
    }
  }
}

/**
 * Helper to create and authenticate a TlonClient
 */
export async function createTlonClient(
  url: string,
  code: string,
  options: TlonClientOptions = {},
): Promise<TlonClient> {
  const cookie = await authenticate(url, code);
  return new TlonClient(url, cookie, options);
}

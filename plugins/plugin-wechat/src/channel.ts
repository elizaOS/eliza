import { Bot } from "./bot";
import { startCallbackServer } from "./callback-server";
import { LoginExpiredError, ProxyClient } from "./proxy-client";
import { ReplyDispatcher } from "./reply-dispatcher";
import type {
  ResolvedWechatAccount,
  WechatConfig,
  WechatMessageContext,
} from "./types";
import { displayQRUrl } from "./utils/qrcode";

const HEALTH_CHECK_INTERVAL_MS = 60_000;
const LOGIN_POLL_INTERVAL_MS = 5_000;
const LOGIN_TIMEOUT_MS = 5 * 60_000;

export interface ChannelOptions {
  config: WechatConfig;
  onMessage: (
    accountId: string,
    msg: WechatMessageContext,
  ) => void | Promise<void>;
}

export class WechatChannel {
  private readonly config: WechatConfig;
  private readonly onMessage: (
    accountId: string,
    msg: WechatMessageContext,
  ) => void | Promise<void>;
  private readonly accounts = new Map<
    string,
    {
      client: ProxyClient;
      dispatcher: ReplyDispatcher;
      bot: Bot;
    }
  >();
  private readonly callbackServers: Array<{
    close: () => Promise<void>;
    port: number;
  }> = [];
  private readonly loginPromises = new Map<string, Promise<void>>();
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private abortController: AbortController | null = null;

  constructor(options: ChannelOptions) {
    this.config = options.config;
    this.onMessage = options.onMessage;
  }

  async start(): Promise<void> {
    this.abortController = new AbortController();
    const resolved = this.resolveAccounts();

    if (resolved.length === 0) {
      console.warn("[wechat] No configured accounts found");
      return;
    }

    const webhookAccountsByPort = new Map<
      number,
      Array<{ accountId: string; apiKey: string }>
    >();
    for (const account of resolved) {
      const existing = webhookAccountsByPort.get(account.webhookPort) ?? [];
      existing.push({ accountId: account.id, apiKey: account.apiKey });
      webhookAccountsByPort.set(account.webhookPort, existing);
    }

    for (const [webhookPort, accounts] of webhookAccountsByPort) {
      try {
        this.callbackServers.push(
          await startCallbackServer({
            port: webhookPort,
            accounts,
            onMessage: (accountId, msg) => this.routeIncoming(accountId, msg),
            signal: this.abortController.signal,
          }),
        );
      } catch (err) {
        const accountIds = accounts.map((a) => a.accountId).join(", ");
        console.error(
          `[wechat] Failed to bind webhook server on port ${webhookPort} for accounts [${accountIds}]:`,
          err,
        );
      }
    }

    // Initialize each account
    for (const account of resolved) {
      const client = new ProxyClient(account);
      const dispatcher = new ReplyDispatcher({ client });
      const bot = new Bot({
        onMessage: (msg) => this.onMessage(account.id, msg),
        featuresGroups: this.config.features?.groups,
        featuresImages: this.config.features?.images,
      });

      this.accounts.set(account.id, { client, dispatcher, bot });

      // Login flow
      await this.ensureLoggedIn(account.id, client);
      const webhookUrl = `http://localhost:${account.webhookPort}/webhook/wechat/${account.id}`;

      try {
        await client.registerWebhook(webhookUrl);
        console.log(
          `[wechat] Account "${account.id}" registered webhook at ${webhookUrl}`,
        );
      } catch (err) {
        console.error(
          `[wechat] Failed to register webhook for "${account.id}":`,
          err,
        );
        throw new Error(
          `Webhook registration failed for account "${account.id}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Periodic health check
    this.healthTimer = setInterval(
      () => this.healthCheck(),
      HEALTH_CHECK_INTERVAL_MS,
    );
  }

  async stop(): Promise<void> {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }

    for (const [, { bot }] of this.accounts) {
      bot.stop();
    }
    this.accounts.clear();

    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }

    const servers = this.callbackServers.splice(0);
    await Promise.all(
      servers.map((server) => server.close().catch(() => undefined)),
    );
  }

  async sendText(accountId: string, to: string, text: string): Promise<void> {
    const entry = this.accounts.get(accountId);
    if (!entry) throw new Error(`Unknown account: ${accountId}`);

    try {
      await entry.dispatcher.sendText(to, text);
    } catch (err) {
      if (err instanceof LoginExpiredError) {
        await this.ensureLoggedIn(accountId, entry.client);
        await entry.dispatcher.sendText(to, text);
      } else {
        throw err;
      }
    }
  }

  async sendImage(
    accountId: string,
    to: string,
    imagePath: string,
    caption?: string,
  ): Promise<void> {
    const entry = this.accounts.get(accountId);
    if (!entry) throw new Error(`Unknown account: ${accountId}`);

    try {
      await entry.dispatcher.sendImage(to, imagePath, caption);
    } catch (err) {
      if (err instanceof LoginExpiredError) {
        await this.ensureLoggedIn(accountId, entry.client);
        await entry.dispatcher.sendImage(to, imagePath, caption);
      } else {
        throw err;
      }
    }
  }

  getAccountIds(): string[] {
    return Array.from(this.accounts.keys());
  }

  async listContacts(accountId: string): Promise<{
    friends: Array<{ wxid: string; name: string }>;
    chatrooms: Array<{ wxid: string; name: string }>;
  }> {
    const entry = this.accounts.get(accountId);
    if (!entry) throw new Error(`Unknown account: ${accountId}`);
    return entry.client.getContacts();
  }

  private routeIncoming(accountId: string, msg: WechatMessageContext): void {
    const entry = this.accounts.get(accountId);
    if (!entry) {
      console.warn(
        `[wechat] Received webhook for unknown account "${accountId}"`,
      );
      return;
    }

    entry.bot.handleIncoming(msg);
  }

  private async ensureLoggedIn(
    accountId: string,
    client: ProxyClient,
  ): Promise<void> {
    const existing = this.loginPromises.get(accountId);
    if (existing) {
      return existing;
    }

    const promise = this.doLogin(accountId, client).finally(() => {
      this.loginPromises.delete(accountId);
    });
    this.loginPromises.set(accountId, promise);
    return promise;
  }

  private async doLogin(accountId: string, client: ProxyClient): Promise<void> {
    const status = await client.getStatus();

    if (status.loginState === "logged_in") {
      console.log(
        `[wechat] Account "${accountId}" logged in as ${status.nickName ?? status.wcId}`,
      );
      return;
    }

    console.log(
      `[wechat] Account "${accountId}" needs login — generating QR code...`,
    );
    const qrUrl = await client.getQRCode();
    displayQRUrl(qrUrl);

    const timeoutMs = this.config.loginTimeoutMs ?? LOGIN_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(LOGIN_POLL_INTERVAL_MS);

      if (this.abortController?.signal.aborted) {
        throw new Error("Login aborted");
      }

      const result = await client.checkLogin();

      if (result.status === "logged_in") {
        console.log(
          `[wechat] Account "${accountId}" logged in as ${result.nickName ?? result.wcId}`,
        );
        return;
      }

      if (result.status === "need_verify") {
        console.log(
          `[wechat] Verification needed: ${result.verifyUrl ?? "check your phone"}`,
        );
      }
    }

    throw new Error(
      `[wechat] Login timed out for account "${accountId}" after ${Math.round(timeoutMs / 1000)} seconds`,
    );
  }

  private async healthCheck(): Promise<void> {
    for (const [accountId, { client }] of this.accounts) {
      try {
        const status = await client.getStatus();
        if (status.loginState !== "logged_in") {
          console.warn(
            `[wechat] Account "${accountId}" login expired — attempting re-login`,
          );
          await this.ensureLoggedIn(accountId, client);
        }
      } catch (err) {
        console.error(`[wechat] Health check failed for "${accountId}":`, err);
      }
    }
  }

  private resolveAccounts(): ResolvedWechatAccount[] {
    const accounts: ResolvedWechatAccount[] = [];
    const rawPort = Number(process.env.ELIZA_WECHAT_WEBHOOK_PORT);
    const envPort =
      Number.isFinite(rawPort) && rawPort > 0 ? rawPort : undefined;
    const defaultPort = envPort ?? this.config.webhookPort ?? 18790;
    const defaultDevice = this.config.deviceType ?? "ipad";

    if (this.config.accounts) {
      for (const [id, acc] of Object.entries(this.config.accounts)) {
        if (acc.enabled === false) continue;
        accounts.push({
          id,
          apiKey: acc.apiKey,
          proxyUrl: acc.proxyUrl,
          deviceType: acc.deviceType ?? defaultDevice,
          webhookPort: acc.webhookPort ?? defaultPort,
          wcId: acc.wcId,
          nickName: acc.nickName,
        });
      }
    } else if (this.config.apiKey && this.config.proxyUrl) {
      accounts.push({
        id: "default",
        apiKey: this.config.apiKey,
        proxyUrl: this.config.proxyUrl,
        deviceType: defaultDevice,
        webhookPort: defaultPort,
      });
    }

    return accounts;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Outbound first-party API client: customer-service replies for Official
 * Accounts (`POST /cgi-bin/message/custom/send`) and app messages for WeCom
 * (`POST /cgi-bin/message/send`), always against the fixed platform hosts.
 * Fetch is injectable so provider-spy tests assert exact host/path/body
 * without network. Token errors route through one forced recovery refresh.
 */

import type { TokenManager } from "./token-manager";
import type { ResolvedWechatAccount, WechatSendReceipt } from "./types";
import { WechatError } from "./types";

const REQUEST_TIMEOUT_MS = 15_000;

export type ApiFetch = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

export class WechatApiClient {
  private readonly tokens: TokenManager;
  private readonly fetchFn: ApiFetch;

  constructor(options: { tokens: TokenManager; fetchFn?: ApiFetch }) {
    this.tokens = options.tokens;
    this.fetchFn = options.fetchFn ?? (globalThis.fetch as unknown as ApiFetch);
  }

  /** Send a text message to one recipient on the account's platform. */
  async sendText(
    account: ResolvedWechatAccount,
    to: string,
    text: string,
  ): Promise<WechatSendReceipt> {
    let token = await this.tokens.getAccessToken(account);
    let receipt = await this.postSend(account, token, to, text);
    if (
      !receipt.ok &&
      (receipt.platformErrorCode === 40001 ||
        receipt.platformErrorCode === 42001)
    ) {
      token = await this.tokens.recoverFromInvalidToken(account);
      receipt = await this.postSend(account, token, to, text);
    }
    return receipt;
  }

  private async postSend(
    account: ResolvedWechatAccount,
    accessToken: string,
    to: string,
    text: string,
  ): Promise<WechatSendReceipt> {
    const isOfficial = account.mode === "official-account";
    const host = isOfficial
      ? "https://api.weixin.qq.com"
      : "https://qyapi.weixin.qq.com";
    const path = isOfficial
      ? "/cgi-bin/message/custom/send"
      : "/cgi-bin/message/send";
    const url = `${host}${path}?access_token=${encodeURIComponent(accessToken)}`;

    const body: Record<string, unknown> = isOfficial
      ? {
          touser: to,
          msgtype: "text",
          text: { content: text },
        }
      : {
          touser: to,
          msgtype: "text",
          agentid: account.wecomAgentId,
          text: { content: text },
        };

    let response: Awaited<ReturnType<ApiFetch>>;
    try {
      response = await this.fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      // error-policy:J2 the transport failure is wrapped in the typed send
      // error with the original cause preserved.
      throw new WechatError(
        "WECHAT_SEND_FAILED",
        "send request to the first-party endpoint failed",
        { accountId: account.id },
        { cause: err },
      );
    }

    // error-policy:J3 a platform body that fails to parse is untrusted input:
    // render it as absent so the caller classifies the send as failed instead
    // of fabricating a success-shaped payload or defaulting errcode to zero.
    const payload = (await response
      .json()
      .catch(() => null)) as WechatApiPayload | null;

    if (response.ok && payload?.errcode === 0) {
      return { ok: true };
    }
    return {
      ok: false,
      platformErrorCode:
        typeof payload?.errcode === "number" ? payload.errcode : undefined,
      redactedDetail:
        typeof payload?.errmsg === "string"
          ? payload.errmsg.slice(0, 120)
          : `http-${response.status}`,
    };
  }
}

interface WechatApiPayload {
  errcode?: unknown;
  errmsg?: unknown;
}

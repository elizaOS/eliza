import { ZALO_OA_API_BASE, ZALO_OAUTH_API_BASE } from "./constants";
import type {
  ZaloApiResponse,
  ZaloOAInfo,
  ZaloSendImageParams,
  ZaloSendMessageParams,
  ZaloUpdate,
} from "./types";

/**
 * Custom fetch function type for proxy support
 */
export type ZaloFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Zalo API error
 */
export class ZaloApiError extends Error {
  constructor(
    message: string,
    public readonly errorCode?: number,
    public readonly description?: string,
  ) {
    super(message);
    this.name = "ZaloApiError";
  }
}

/**
 * Call the Zalo OA API
 */
export async function callZaloApi<T = unknown>(
  endpoint: string,
  accessToken: string,
  body?: Record<string, unknown>,
  options?: { timeoutMs?: number; fetch?: ZaloFetch; method?: string },
): Promise<ZaloApiResponse<T>> {
  const url = `${ZALO_OA_API_BASE}${endpoint}`;
  const controller = new AbortController();
  const timeoutId = options?.timeoutMs
    ? setTimeout(() => controller.abort(), options.timeoutMs)
    : undefined;
  const fetcher = options?.fetch ?? fetch;

  try {
    const response = await fetcher(url, {
      method: options?.method || (body ? "POST" : "GET"),
      headers: {
        "Content-Type": "application/json",
        access_token: accessToken,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    const data = (await response.json()) as ZaloApiResponse<T>;

    if (data.error !== 0) {
      throw new ZaloApiError(
        data.message || `Zalo API error: ${endpoint}`,
        data.error,
        data.message,
      );
    }

    return data;
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

/**
 * Get OA information
 */
export async function getOAInfo(
  accessToken: string,
  timeoutMs?: number,
  fetcher?: ZaloFetch,
): Promise<ZaloApiResponse<ZaloOAInfo>> {
  return callZaloApi<ZaloOAInfo>("/getoa", accessToken, undefined, {
    timeoutMs,
    fetch: fetcher,
  });
}

/**
 * Send a text message
 */
export async function sendMessage(
  accessToken: string,
  params: ZaloSendMessageParams,
  fetcher?: ZaloFetch,
): Promise<ZaloApiResponse<{ message_id: string }>> {
  return callZaloApi<{ message_id: string }>(
    "/message",
    accessToken,
    {
      recipient: { user_id: params.userId },
      message: { text: params.text },
    },
    { fetch: fetcher },
  );
}

/**
 * Send an image message
 */
export async function sendImage(
  accessToken: string,
  params: ZaloSendImageParams,
  fetcher?: ZaloFetch,
): Promise<ZaloApiResponse<{ message_id: string }>> {
  const message: Record<string, unknown> = {
    attachment: {
      type: "template",
      payload: {
        template_type: "media",
        elements: [
          {
            media_type: "image",
            url: params.imageUrl,
          },
        ],
      },
    },
  };

  if (params.caption) {
    message.text = params.caption;
  }

  return callZaloApi<{ message_id: string }>(
    "/message",
    accessToken,
    {
      recipient: { user_id: params.userId },
      message,
    },
    { fetch: fetcher },
  );
}

/**
 * Get user profile by ID
 */
export async function getUserProfile(
  accessToken: string,
  userId: string,
  fetcher?: ZaloFetch,
): Promise<
  ZaloApiResponse<{ user_id: string; display_name: string; avatar: string }>
> {
  return callZaloApi(
    `/getprofile?data=${encodeURIComponent(JSON.stringify({ user_id: userId }))}`,
    accessToken,
    undefined,
    { fetch: fetcher, method: "GET" },
  );
}

/**
 * Refresh the access token
 */
export async function refreshAccessToken(
  appId: string,
  secretKey: string,
  refreshToken: string,
  fetcher?: ZaloFetch,
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const url = `${ZALO_OAUTH_API_BASE}/oa/access_token`;
  const response = await (fetcher ?? fetch)(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      secret_key: secretKey,
    },
    body: new URLSearchParams({
      app_id: appId,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  const data = (await response.json()) as {
    error?: string;
    error_description?: string;
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };

  if (data.error) {
    throw new ZaloApiError(
      data.error_description || "Failed to refresh token",
      undefined,
      data.error,
    );
  }

  return {
    accessToken: data.access_token ?? "",
    refreshToken: data.refresh_token ?? "",
    expiresIn: data.expires_in ?? 0,
  };
}

/**
 * Create a proxy-enabled fetch function
 */
export function createProxyFetch(proxyUrl: string): ZaloFetch {
  // In a browser/Bun environment, we'd use the proxy differently
  // For now, return a function that adds proxy headers
  return async (input: string, init?: RequestInit): Promise<Response> => {
    // Note: Actual proxy implementation depends on the runtime
    // In Node.js, you'd use an agent; in Bun/browser, different approach
    console.warn(`Proxy configured but not implemented: ${proxyUrl}`);
    return fetch(input, init);
  };
}

/**
 * Parse incoming webhook update
 */
export function parseWebhookUpdate(body: unknown): ZaloUpdate | null {
  if (!body || typeof body !== "object") {
    return null;
  }

  const data = body as Record<string, unknown>;
  const eventName = data.event_name as string;

  if (!eventName) {
    return null;
  }

  const update: ZaloUpdate = {
    eventName: eventName as ZaloUpdate["eventName"],
    timestamp: data.timestamp as number,
  };

  // Parse message events
  if (eventName.startsWith("message.")) {
    const sender = data.sender as Record<string, unknown> | undefined;
    const messageData = data.message as Record<string, unknown> | undefined;

    if (sender && messageData) {
      update.message = {
        messageId: messageData.msg_id as string,
        from: {
          id: sender.id as string,
        },
        chat: {
          id: sender.id as string,
          chatType: "PRIVATE",
        },
        date: Math.floor((data.timestamp as number) / 1000),
        text: messageData.text as string | undefined,
      };
    }
  }

  // Parse follow/unfollow events
  if (eventName === "follow" || eventName === "unfollow") {
    const follower = data.follower as Record<string, unknown> | undefined;
    if (follower) {
      update.userId = follower.id as string;
    }
  }

  return update;
}

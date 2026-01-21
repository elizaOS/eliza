/**
 * Farcaster Sign-In Client
 *
 * Implements the proper Sign In with Farcaster (SIWF) protocol flow:
 * 1. Create a channel on the Farcaster relay server
 * 2. Present the auth URL/QR code to the user
 * 3. Poll the relay for authentication status
 * 4. Return the signed message and user data
 *
 * @see https://github.com/farcasterxyz/protocol/discussions/110
 */

import { logger } from "../utils/logger";

const FARCASTER_RELAY_URL = "https://relay.farcaster.xyz";
const CHANNEL_POLL_INTERVAL_MS = 1500;
const CHANNEL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export interface FarcasterAuthResult {
  message: string;
  signature: string;
  fid: number;
  username: string;
  displayName?: string;
  pfpUrl?: string;
  bio?: string;
  nonce: string;
}

interface ChannelCreateResponse {
  channelToken: string;
  url: string;
  nonce: string;
}

interface ChannelStatusResponse {
  state: "pending" | "completed";
  message?: string;
  signature?: string;
  fid?: number;
  username?: string;
  displayName?: string;
  pfpUrl?: string;
  bio?: string;
  nonce?: string;
}

/**
 * Creates a new authentication channel on the Farcaster relay
 */
async function createChannel(
  domain: string,
  siweUri: string,
  nonce?: string,
): Promise<ChannelCreateResponse> {
  const body: Record<string, string> = {
    siweUri,
    domain,
  };

  if (nonce) {
    body.nonce = nonce;
  }

  const response = await fetch(`${FARCASTER_RELAY_URL}/v1/channel`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    logger.error(
      "Failed to create Farcaster auth channel",
      {
        status: response.status,
        error: errorText,
      },
      "FarcasterAuthClient",
    );
    throw new Error(`Failed to create auth channel: ${response.status}`);
  }

  return response.json() as Promise<ChannelCreateResponse>;
}

/**
 * Polls the channel status until authentication completes or times out
 */
async function pollChannelStatus(
  channelToken: string,
  onStatusUpdate?: (state: "pending" | "completed") => void,
  signal?: AbortSignal,
): Promise<FarcasterAuthResult> {
  const startTime = Date.now();

  while (Date.now() - startTime < CHANNEL_TIMEOUT_MS) {
    if (signal?.aborted) {
      throw new Error("Authentication cancelled");
    }

    const response = await fetch(`${FARCASTER_RELAY_URL}/v1/channel/status`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${channelToken}`,
      },
      signal,
    });

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error("Channel expired or invalid");
      }
      const errorText = await response.text();
      logger.warn(
        "Channel status check failed",
        {
          status: response.status,
          error: errorText,
        },
        "FarcasterAuthClient",
      );
      // Continue polling on transient errors
      await sleep(CHANNEL_POLL_INTERVAL_MS);
      continue;
    }

    const status = (await response.json()) as ChannelStatusResponse;
    onStatusUpdate?.(status.state);

    if (status.state === "completed") {
      if (
        !status.message ||
        !status.signature ||
        !status.fid ||
        !status.username
      ) {
        throw new Error("Incomplete authentication response");
      }

      return {
        message: status.message,
        signature: status.signature,
        fid: status.fid,
        username: status.username,
        displayName: status.displayName,
        pfpUrl: status.pfpUrl,
        bio: status.bio,
        nonce: status.nonce || "",
      };
    }

    await sleep(CHANNEL_POLL_INTERVAL_MS);
  }

  throw new Error("Authentication timeout");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Generate a cryptographically secure nonce
 */
function generateNonce(): string {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return Array.from(array, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export interface FarcasterSignInOptions {
  /** User ID to include in state for backend verification */
  userId: string;
  /** Callback when authentication status changes */
  onStatusUpdate?: (state: "pending" | "completed") => void;
  /** Callback when popup is opened with the URL */
  onPopupOpen?: (url: string) => void;
  /** Optional abort signal to cancel authentication */
  signal?: AbortSignal;
}

/**
 * Opens a popup for Farcaster Sign-In and handles the full authentication flow
 *
 * This implements the proper SIWF protocol:
 * 1. Creates a channel on the Farcaster relay server
 * 2. Opens a popup with the auth URL
 * 3. Polls the relay for completion
 * 4. Returns the authentication result
 */
export async function signInWithFarcaster(
  options: FarcasterSignInOptions,
): Promise<FarcasterAuthResult & { state: string }> {
  const { userId, onStatusUpdate, onPopupOpen, signal } = options;

  // Get the domain from environment or current location
  const appUrl =
    process.env.NEXT_PUBLIC_APP_URL ||
    (typeof window !== "undefined" ? window.location.origin : "");
  const domain = new URL(appUrl).hostname;
  const siweUri = `${appUrl}/api/auth/farcaster/callback`;

  // Generate nonce for this authentication request
  const nonce = generateNonce();

  logger.info(
    "Creating Farcaster auth channel",
    { domain, siweUri },
    "FarcasterAuthClient",
  );

  // Step 1: Create channel on relay
  const channel = await createChannel(domain, siweUri, nonce);

  logger.info(
    "Farcaster auth channel created",
    {
      channelToken: `${channel.channelToken.substring(0, 8)}...`,
      url: channel.url,
    },
    "FarcasterAuthClient",
  );

  // Step 2: Open popup with the auth URL
  if (typeof window === "undefined") {
    throw new Error("signInWithFarcaster can only be called in the browser");
  }

  const width = 500;
  const height = 700;
  const left = window.screen.width / 2 - width / 2;
  const top = window.screen.height / 2 - height / 2;

  const popup = window.open(
    channel.url,
    "farcaster-auth",
    `width=${width},height=${height},left=${left},top=${top},scrollbars=yes,resizable=yes`,
  );

  if (!popup) {
    throw new Error("Failed to open popup. Please allow popups for this site.");
  }

  onPopupOpen?.(channel.url);

  // Create abort controller to handle popup close
  const abortController = new AbortController();
  const combinedSignal = signal
    ? AbortSignal.any([signal, abortController.signal])
    : abortController.signal;

  // Monitor popup close
  const popupCheckInterval = setInterval(() => {
    if (popup.closed) {
      clearInterval(popupCheckInterval);
      abortController.abort();
    }
  }, 500);

  // Step 3: Poll for authentication completion
  const result = await pollChannelStatus(
    channel.channelToken,
    onStatusUpdate,
    combinedSignal,
  );

  // Close popup if still open
  if (!popup.closed) {
    popup.close();
  }

  // Generate state for backend verification (userId|timestamp|random)
  // Using pipe separator because userId may contain colons (e.g., did:privy:xxx)
  const state = `${userId}|${Date.now()}|${Math.random().toString(36).substring(7)}`;

  logger.info(
    "Farcaster authentication completed",
    {
      fid: result.fid,
      username: result.username,
    },
    "FarcasterAuthClient",
  );

  clearInterval(popupCheckInterval);
  if (!popup.closed) {
    popup.close();
  }

  return {
    ...result,
    state,
  };
}

/**
 * Creates an auth channel and returns the URL for QR code display
 * Useful for mobile-first flows where you want to show a QR code
 */
export async function createFarcasterAuthChannel(userId: string): Promise<{
  channelToken: string;
  url: string;
  nonce: string;
  state: string;
}> {
  const appUrl =
    process.env.NEXT_PUBLIC_APP_URL ||
    (typeof window !== "undefined" ? window.location.origin : "");
  const domain = new URL(appUrl).hostname;
  const siweUri = `${appUrl}/api/auth/farcaster/callback`;
  const nonce = generateNonce();

  const channel = await createChannel(domain, siweUri, nonce);
  // Using pipe separator because userId may contain colons (e.g., did:privy:xxx)
  const state = `${userId}|${Date.now()}|${Math.random().toString(36).substring(7)}`;

  return {
    ...channel,
    state,
  };
}

/**
 * Polls an existing channel for completion
 * Use with createFarcasterAuthChannel for custom UIs
 */
export { pollChannelStatus };

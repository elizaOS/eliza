/**
 * Confirms proof-bearing identity-link codes received by the managed Eliza App
 * Discord bot before they can enter the ordinary agent message path.
 */

const LINK_CODE_PATTERN = /\bLINK-([A-HJ-NP-Z2-9]{8})\b/i;
const CONFIRM_TIMEOUT_MS = 15_000;

export interface DiscordIdentityLinkDeps {
  cloudBaseUrl: string;
  getAuthHeader: () => { Authorization: string };
  fetchImpl?: typeof fetch;
}

export type DiscordIdentityLinkAttempt =
  | { handled: false }
  | { handled: true; linked: boolean; reply: string };

/** Confirms a code as the gateway-attested Discord sender, when one is present. */
export async function tryConfirmDiscordIdentityLink(
  deps: DiscordIdentityLinkDeps,
  input: { text: string; discordUserId: string; discordUsername: string },
): Promise<DiscordIdentityLinkAttempt> {
  const match = LINK_CODE_PATTERN.exec(input.text);
  if (!match) return { handled: false };

  const response = await (deps.fetchImpl ?? fetch)(
    `${deps.cloudBaseUrl}/api/eliza-app/identity-link/confirm`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...deps.getAuthHeader() },
      body: JSON.stringify({
        code: `LINK-${match[1].toUpperCase()}`,
        platform: "discord",
        platformId: input.discordUserId,
        platformName: input.discordUsername,
      }),
      signal: AbortSignal.timeout(CONFIRM_TIMEOUT_MS),
    },
  );
  if (response.ok) {
    return {
      handled: true,
      linked: true,
      reply:
        "You're linked! This Discord account is now connected to your eliza.app account. Just keep chatting here.",
    };
  }
  if (response.status !== 409) {
    throw new Error(
      `Discord identity-link confirm failed (${response.status})`,
    );
  }

  const body = (await response.json().catch(() => null)) as {
    data?: { status?: string };
  } | null;
  return {
    handled: true,
    linked: false,
    reply: replyForRejection(body?.data?.status),
  };
}

function replyForRejection(status: string | undefined): string {
  switch (status) {
    case "expired":
      return "That link code has expired. Generate a fresh Discord code from your eliza.app settings and send it here within 10 minutes.";
    case "already_used":
      return "That link code was already used. If this wasn't you, generate a new code from your eliza.app settings.";
    case "platform_mismatch":
      return "That link code was created for a different platform. Generate a Discord code from your eliza.app settings.";
    case "handle_conflict":
      return "This Discord account is already linked to a different eliza.app account, so the code can't be applied.";
    default:
      return "That doesn't look like a valid link code. Double-check it or generate a new one from your eliza.app settings.";
  }
}

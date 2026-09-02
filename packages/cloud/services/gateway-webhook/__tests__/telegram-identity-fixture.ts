import { __resetTelegramIdentityAttestationCacheForTests } from "@elizaos/cloud-services-common/telegram-connector";

export const TELEGRAM_TEST_TOKEN = "123456789:test-token";
export const TELEGRAM_TEST_BOT_ID = "123456789";
export const TELEGRAM_TEST_BOT_USERNAME = "ElizaTestBot";
export const TELEGRAM_TEST_WEBHOOK_SECRET = "provider-secret";
export const TELEGRAM_CONNECTOR_ACCOUNT_ID = `bot:${TELEGRAM_TEST_BOT_ID}`;

export function configureTelegramIdentity({
  token = TELEGRAM_TEST_TOKEN,
  botId = token.split(":", 1)[0] ?? TELEGRAM_TEST_BOT_ID,
  botUsername = TELEGRAM_TEST_BOT_USERNAME,
  webhookSecret = TELEGRAM_TEST_WEBHOOK_SECRET,
}: {
  token?: string;
  botId?: string;
  botUsername?: string;
  webhookSecret?: string;
} = {}): void {
  process.env.ELIZA_APP_TELEGRAM_BOT_TOKEN = token;
  process.env.ELIZA_APP_TELEGRAM_BOT_ID = botId;
  process.env.ELIZA_APP_TELEGRAM_BOT_USERNAME = botUsername;
  process.env.ELIZA_APP_TELEGRAM_WEBHOOK_SECRET = webhookSecret;
}

export function resetTelegramIdentityAttestation(): void {
  __resetTelegramIdentityAttestationCacheForTests();
}

export function isTelegramGetMeRequest(input: RequestInfo | URL): boolean {
  const url = input instanceof Request ? input.url : String(input);
  return /\/bot[^/]+\/getMe(?:\?|$)/u.test(url);
}

export function telegramGetMeResponse(
  input: RequestInfo | URL,
  {
    botId,
    botUsername = TELEGRAM_TEST_BOT_USERNAME,
  }: { botId?: number; botUsername?: string } = {},
): Response {
  const url = input instanceof Request ? input.url : String(input);
  const tokenBotId = /^https:\/\/api\.telegram\.org\/bot(\d+):/u.exec(url)?.[1];
  return Response.json({
    ok: true,
    result: {
      id: botId ?? Number(tokenBotId ?? TELEGRAM_TEST_BOT_ID),
      is_bot: true,
      username: botUsername,
    },
  });
}

export function withTelegramIdentity(
  fallback: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Response | Promise<Response>,
  providerIdentity: { botId?: number; botUsername?: string } = {},
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (isTelegramGetMeRequest(input)) {
      return telegramGetMeResponse(input, providerIdentity);
    }
    return fallback(input, init);
  }) as typeof fetch;
}

import { afterEach, expect, spyOn, test } from "bun:test";
import { logger } from "../../utils/logger";
import { sendSocialMediaAlert } from "./alerts";

const spies: ReturnType<typeof spyOn>[] = [];

const ENV_KEYS = [
  "SOCIAL_ALERTS_DISCORD_WEBHOOK",
  "SOCIAL_ALERTS_SLACK_WEBHOOK",
  "SOCIAL_ALERTS_TELEGRAM_BOT_TOKEN",
  "SOCIAL_ALERTS_TELEGRAM_CHAT_ID",
  "SOCIAL_ALERTS_WHATSAPP_API_URL",
  "SOCIAL_ALERTS_WHATSAPP_API_KEY",
  "SOCIAL_ALERTS_WHATSAPP_TO",
] as const;

const savedEnv = new Map<string, string | undefined>(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function stubFetch(response: Response) {
  const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(response);
  spies.push(fetchSpy);
  return fetchSpy;
}

function stubErrorLog() {
  const errorSpy = spyOn(logger, "error").mockImplementation(() => {});
  spies.push(errorSpy);
  return errorSpy;
}

test("a webhook that rejects the alert is reported as a delivery failure", async () => {
  process.env.SOCIAL_ALERTS_DISCORD_WEBHOOK = "https://discord.example/api/webhooks/1/token";
  const fetchSpy = stubFetch(new Response("Invalid Webhook Token", { status: 401 }));
  const errorSpy = stubErrorLog();

  await sendSocialMediaAlert({ severity: "high", title: "Post failed", message: "boom" });

  expect(fetchSpy).toHaveBeenCalledTimes(1);
  expect(errorSpy).toHaveBeenCalledTimes(1);
  expect(String(errorSpy.mock.calls[0]?.[0])).toContain("1/1 channels failed");
});

test("an accepted webhook is not reported as a failure", async () => {
  process.env.SOCIAL_ALERTS_DISCORD_WEBHOOK = "https://discord.example/api/webhooks/1/token";
  stubFetch(new Response(null, { status: 204 }));
  const errorSpy = stubErrorLog();

  await sendSocialMediaAlert({ severity: "low", title: "Rate limited", message: "slow down" });

  expect(errorSpy).not.toHaveBeenCalled();
});

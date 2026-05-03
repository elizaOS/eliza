import { logger } from "@/lib/utils/logger";

type AlertSeverity = "critical" | "high" | "medium" | "low";

interface AlertPayload {
  severity: AlertSeverity;
  title: string;
  message: string;
  platforms?: string[];
}

const SEVERITY_COLORS: Record<AlertSeverity, { hex: string; emoji: string }> = {
  critical: { hex: "#FF0000", emoji: "🚨" },
  high: { hex: "#FF8C00", emoji: "⚠️" },
  medium: { hex: "#FFD700", emoji: "📊" },
  low: { hex: "#00CED1", emoji: "ℹ️" },
};

async function sendDiscordAlert(webhookUrl: string, payload: AlertPayload): Promise<void> {
  const { hex, emoji } = SEVERITY_COLORS[payload.severity];

  await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      embeds: [
        {
          title: `${emoji} ${payload.title}`,
          description: payload.message,
          color: parseInt(hex.slice(1), 16),
          fields: payload.platforms?.length
            ? [
                {
                  name: "Platforms",
                  value: payload.platforms.join(", "),
                  inline: true,
                },
              ]
            : [],
          timestamp: new Date().toISOString(),
        },
      ],
    }),
  });
}

async function sendSlackAlert(webhookUrl: string, payload: AlertPayload): Promise<void> {
  const { emoji } = SEVERITY_COLORS[payload.severity];

  await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      blocks: [
        {
          type: "header",
          text: {
            type: "plain_text",
            text: `${emoji} ${payload.title}`,
            emoji: true,
          },
        },
        { type: "section", text: { type: "mrkdwn", text: payload.message } },
        ...(payload.platforms?.length
          ? [
              {
                type: "section",
                fields: [
                  {
                    type: "mrkdwn",
                    text: `*Platforms:* ${payload.platforms.join(", ")}`,
                  },
                ],
              },
            ]
          : []),
      ],
    }),
  });
}

async function sendTelegramAlert(
  botToken: string,
  chatId: string,
  payload: AlertPayload,
): Promise<void> {
  const { emoji } = SEVERITY_COLORS[payload.severity];
  const text = [
    `${emoji} *${payload.title}*`,
    "",
    payload.message,
    ...(payload.platforms?.length ? ["", `Platforms: ${payload.platforms.join(", ")}`] : []),
  ].join("\n");

  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
  });
}

async function sendWhatsAppAlert(
  apiUrl: string,
  apiKey: string,
  to: string,
  payload: AlertPayload,
): Promise<void> {
  const { emoji } = SEVERITY_COLORS[payload.severity];
  const text = [
    `${emoji} ${payload.title}`,
    "",
    payload.message,
    ...(payload.platforms?.length ? ["", `Platforms: ${payload.platforms.join(", ")}`] : []),
  ].join("\n");

  await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ to, message: text }),
  });
}

export async function sendSocialMediaAlert(payload: AlertPayload): Promise<void> {
  const sends: Promise<void>[] = [];

  const discordWebhook = process.env.SOCIAL_ALERTS_DISCORD_WEBHOOK;
  const slackWebhook = process.env.SOCIAL_ALERTS_SLACK_WEBHOOK;
  const tgToken = process.env.SOCIAL_ALERTS_TELEGRAM_BOT_TOKEN;
  const tgChat = process.env.SOCIAL_ALERTS_TELEGRAM_CHAT_ID;
  const waUrl = process.env.SOCIAL_ALERTS_WHATSAPP_API_URL;
  const waKey = process.env.SOCIAL_ALERTS_WHATSAPP_API_KEY;
  const waTo = process.env.SOCIAL_ALERTS_WHATSAPP_TO;

  if (discordWebhook) sends.push(sendDiscordAlert(discordWebhook, payload));
  if (slackWebhook) sends.push(sendSlackAlert(slackWebhook, payload));
  if (tgToken && tgChat) sends.push(sendTelegramAlert(tgToken, tgChat, payload));
  if (waUrl && waKey && waTo) sends.push(sendWhatsAppAlert(waUrl, waKey, waTo, payload));

  if (sends.length === 0) {
    logger.warn("[SocialMediaAlerts] No alert channels configured");
    return;
  }

  const results = await Promise.allSettled(sends);
  const failures = results.filter((r) => r.status === "rejected").length;
  if (failures > 0)
    logger.error(`[SocialMediaAlerts] ${failures}/${results.length} channels failed`);
}

export async function alertOnPostFailure(
  organizationId: string,
  platforms: string[],
  _errors: string[],
): Promise<void> {
  const allFailed = _errors.length === platforms.length;
  await sendSocialMediaAlert({
    severity: allFailed ? "high" : "medium",
    title: allFailed ? "All Social Media Posts Failed" : "Partial Social Media Post Failure",
    message: `${_errors.length}/${platforms.length} posts failed for org ${organizationId.slice(0, 8)}...`,
    platforms,
  });
}

export async function alertOnTokenExpiry(organizationId: string, platform: string): Promise<void> {
  await sendSocialMediaAlert({
    severity: "medium",
    title: "Social Media Token Expired",
    message: `Token for ${platform} expired (org ${organizationId.slice(0, 8)}...). Re-authentication required.`,
    platforms: [platform],
  });
}

export async function alertOnRateLimit(platform: string, retryAfter?: number): Promise<void> {
  await sendSocialMediaAlert({
    severity: "low",
    title: "Social Media Rate Limited",
    message: `${platform} API rate limit reached. ${retryAfter ? `Retry after ${retryAfter}s.` : ""}`,
    platforms: [platform],
  });
}

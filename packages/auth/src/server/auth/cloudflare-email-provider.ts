import type { EmailDeliveryReceipt, EmailProvider } from "./email-provider";

export class CloudflareEmailProvider implements EmailProvider {
  constructor(
    private readonly config: {
      accountId: string;
      apiToken: string;
      from: string;
    },
  ) {}

  async send(
    to: string,
    subject: string,
    text: string,
    html?: string,
    options?: { replyTo?: string },
  ): Promise<EmailDeliveryReceipt> {
    const { accountId, apiToken, from } = this.config;
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/email/sending/send`,
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(25_000),
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          to: [to],
          from,
          subject,
          text,
          html,
          reply_to: options?.replyTo,
        }),
      },
    );
    if (!response.ok) throw new Error("Cloudflare Email Sending rejected send");

    const body: {
      success?: unknown;
      result?: {
        message_id?: unknown;
        delivered?: unknown;
        queued?: unknown;
        permanent_bounces?: unknown;
        suppressed_recipients?: unknown;
      };
    } | null = await response.json();
    const result = body?.result;
    const containsRecipient = (list: unknown) =>
      Array.isArray(list) && list.includes(to);
    const id = result?.message_id;
    if (
      body?.success !== true ||
      typeof id !== "string" ||
      !id.trim() ||
      containsRecipient(result?.permanent_bounces) ||
      containsRecipient(result?.suppressed_recipients) ||
      !(
        containsRecipient(result?.delivered) ||
        containsRecipient(result?.queued)
      )
    ) {
      throw new Error("Cloudflare Email Sending did not accept recipient");
    }
    return { provider: "cloudflare", id };
  }
}

/** Builds validated, nonce-enforced Discord reply payloads and link CTAs. */
import type { MessageReplyOptions } from "discord.js";

/**
 * Link handoff returned by the cloud routing API. The URL is the same login
 * URL the plain-text path would have inlined; here it rides a style-5 Link
 * button instead (Link buttons carry their URL directly and need no
 * interaction endpoint).
 */
export interface RoutedReplyCta {
  label?: unknown;
  url?: unknown;
}

const MAX_BUTTON_LABEL_LENGTH = 80; // Discord's button label limit
/**
 * Discord rejects button URLs over 512 characters at the API, and the send
 * failure would be swallowed by the reply catch, leaving the user with no
 * message at all. A too-long URL therefore drops the button (plain-text reply)
 * instead of risking the whole send.
 */
const MAX_BUTTON_URL_LENGTH = 512;

interface LinkButtonComponent {
  type: 2;
  style: 5;
  label: string;
  url: string;
}

interface ActionRowComponent {
  type: 1;
  components: LinkButtonComponent[];
}

export const MANAGED_REPLY_UNAVAILABLE_TEXT =
  "I couldn't finish that turn right now. Please try again in a moment.";

/**
 * Converts a routed reply CTA into a Discord action row with one Link button.
 * Returns null (send a plain message, never crash the reply) when the CTA is
 * malformed: missing/empty label or URL, or a non-https URL. The login URL is
 * minted server-side, so anything else here means a contract drift upstream -
 * dropping the button degrades to the plain reply text.
 */
export function buildReplyComponents(
  cta: RoutedReplyCta | null | undefined,
): ActionRowComponent[] | null {
  if (!cta) return null;
  const label = typeof cta.label === "string" ? cta.label.trim() : "";
  const url = typeof cta.url === "string" ? cta.url.trim() : "";
  if (!label || !url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // error-policy:J3 Routed CTA data is untrusted; malformed URLs produce an
    // explicit no-component result and leave the safe plain-text reply intact.
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (url.length > MAX_BUTTON_URL_LENGTH) return null;
  return [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 5,
          label: label.slice(0, MAX_BUTTON_LABEL_LENGTH),
          url,
        },
      ],
    },
  ];
}

/**
 * Binds an outbound reply to the inbound Discord snowflake. Within Discord's
 * nonce window a repeat send under the same nonce is deduplicated — the API
 * returns the message that already exists rather than creating a second one —
 * so discord.js REST retries and a gateway resume replay cannot double-post
 * after an ambiguous timeout or 5xx.
 */
export function buildManagedReplyOptions(
  inboundMessageId: string,
  content: string,
  cta?: RoutedReplyCta | null,
): MessageReplyOptions {
  const components = buildReplyComponents(cta);
  return {
    content,
    nonce: inboundMessageId,
    enforceNonce: true,
    ...(components ? { components } : {}),
    allowedMentions: { repliedUser: false },
  };
}

/**
 * Derives a nonce distinct from the primary reply's.
 *
 * Sharing the primary nonce would make the two messages interchangeable to
 * Discord's deduplicator: once a failure notice has been posted, a later
 * replay of the same inbound message — a gateway resume, with the cloud route
 * idempotent on the inbound id and returning the same answer — would have its
 * real reply deduplicated against the notice, and the user would permanently
 * see the failure text instead of the answer that was computed. Discord caps
 * the nonce at 25 characters and a snowflake is 19, so the suffix always fits.
 */
export function buildManagedFailureReplyOptions(
  inboundMessageId: string,
): MessageReplyOptions {
  return buildManagedReplyOptions(
    `${inboundMessageId}-f`,
    MANAGED_REPLY_UNAVAILABLE_TEXT,
  );
}

export type ManagedReplyReceiptStatus = "delivered" | "deduplicated";

/**
 * Distinguishes a fulfilled send from Discord returning a different message
 * that already owns the nonce. Same-payload nonce replays are semantically
 * delivered regardless of whether this request created the message.
 */
export function classifyManagedReplyReceipt(
  receipt: { content: string; nonce: string | number | null },
  expected: MessageReplyOptions,
): ManagedReplyReceiptStatus {
  return receipt.content === expected.content &&
    String(receipt.nonce) === String(expected.nonce)
    ? "delivered"
    : "deduplicated";
}

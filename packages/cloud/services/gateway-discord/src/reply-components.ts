/** Builds validated Discord link-button components for routed reply CTAs. */

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

/**
 * Copy for the eliza.app home page once Eliza becomes The Network's agent.
 *
 * Source of the wording: eliza-research/thenetwork on main — docs/go-live-handoff.md section 7 prerequisites 5 and 6,
 * docs/design/eliza-conversation-layer.md, AGENTS.md, sites/PRODUCT.md, and
 * the one-time notice `ELIZA_NOTICE` in packages/network/src/copy.ts.
 *
 * DRAFT: the founder must approve the wording before this ships. The page is
 * mounted only when `VITE_NETWORK_HOME=1` is set at build time (see
 * ./network-home-flag.ts), so nothing changes for eliza.app visitors until
 * then. Do not flip the status here; flip it when the founder says yes.
 */

export const NETWORK_HOME_COPY_STATUS: "DRAFT" | "APPROVED" = "DRAFT";

/** The shared iMessage/SMS line (PRODUCTION_BLOOIO_SENDER_NUMBERS). */
export const NETWORK_LINE_E164 = "+18087881821";
export const NETWORK_LINE_DISPLAY = "+1 (808) 788-1821";

export interface NetworkAppLink {
  name: string;
  href: string;
  line: string;
}

export const NETWORK_HOME_COPY = {
  metaTitle: "Eliza | The Network's agent",
  eyebrow: "Eliza is The Network's agent",
  headline: "People worth meeting, found by your agent.",
  subhead:
    "Text Eliza and tell her what you're looking for: friends, dating or work. She'll ask a few questions and introduce you when both sides say yes.",
  /** Primary CTA. The accessible name matches the homepage readiness check. */
  primaryCta: "Text Eliza",
  numberLabel: "Eliza's number:",
  secondaryCta: "What is The Network?",
  networkHref: "https://ntwrk.party",
  appsHeading: "All of these apps are powered by The Network.",
  apps: [
    {
      name: "slop.date",
      href: "https://slop.date",
      line: "Dating, through your agent.",
    },
    {
      name: "friends.help",
      href: "https://friends.help",
      line: "New friends in New York, through your agent.",
    },
    {
      name: "peon.biz",
      href: "https://peon.biz",
      line: "Work, found by your agent.",
    },
  ] satisfies NetworkAppLink[],
  /**
   * Web form of the one-time notice existing eliza.app users get on their next
   * message (ELIZA_NOTICE, thenetwork packages/network/src/copy.ts).
   */
  existingUsersHeading: "Already text Eliza?",
  existingUsersBody:
    "Eliza is now the agent of The Network, which helps people meet for friends, dating and work. Nothing changes for you unless you join, and nobody is matched with you without your consent. Reply STOP anytime to stop all messages from this number.",
  footer: "Message and data rates may apply. Text HELP for help, STOP to stop.",
} as const;

/** `sms:` deep link to the shared line; iOS opens iMessage for this number. */
export function networkLineSmsHref(): string {
  return `sms:${NETWORK_LINE_E164}`;
}

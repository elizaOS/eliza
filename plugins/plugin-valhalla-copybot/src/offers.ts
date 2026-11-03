import catalog from "../offers.json" with { type: "json" };

export const AFFILIATE_LABEL = "Affiliate link · we may earn a commission";

export interface Offer {
  id: string;
  partner: string;
  title: string;
  blurb: string;
  url: string;
  image: string;
  placements: string[];
  tier: "free" | "all";
  category: string;
  disclosure: string;
}

function rows(): Offer[] {
  return catalog.offers as Offer[];
}

/** A link is live only when the owner has pasted an https URL. */
export function isLive(offer: Offer): boolean {
  return offer.url.startsWith("https://");
}

/**
 * Pro and trial see no offers except the public /tools page.
 * Empty URLs stay out of every placement.
 */
export function offersFor(placement: string, paid = false): Offer[] {
  if (placement !== "tools" && paid) return [];
  return rows().filter((offer) => {
    if (!isLive(offer)) return false;
    if (placement === "tools") return true;
    return offer.placements.includes(placement);
  });
}

export function toolsMessage(): string {
  const live = offersFor("tools", false);
  const head = ["Recommended tools.", AFFILIATE_LABEL + ".", "Not trading advice."];
  if (!live.length) {
    return [...head, "No partner link is connected yet."].join("\n");
  }
  return [...head, ...live.map((offer) => `${offer.partner}: ${offer.title}. ${offer.url}`)].join(
    "\n"
  );
}

/** Desk chat and a Telegram /tools command. Other text returns null. */
export function answerTools(text: string): string | null {
  const cleaned = text
    .trim()
    .toLowerCase()
    .replace(/^\/tools@\S+/, "/tools");
  if (cleaned === "/tools" || cleaned.startsWith("/tools ")) return toolsMessage();
  return null;
}

export function contextForScore(score: number, paid = false): string {
  if (paid || score > 40) return "";
  const offer = offersFor("risk-score", false)[0];
  if (!offer) {
    return "Protect your coins: hardware wallet. Not trading advice.";
  }
  return `${offer.title}. ${offer.partner}. ${offer.url}. ${AFFILIATE_LABEL}. Not trading advice.`;
}

export function contextForReport(paid = false): string {
  if (paid) return "";
  const offer = offersFor("report-card", false)[0];
  if (!offer) return "Chart better. Not trading advice.";
  return `Chart better. ${offer.partner}. ${offer.url}. ${AFFILIATE_LABEL}. Not trading advice.`;
}

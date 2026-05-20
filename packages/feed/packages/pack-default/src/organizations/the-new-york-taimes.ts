import type { PackOrganization } from "@feed/shared";

const organization = {
  id: "the-new-york-taimes",
  name: "The New York TAImes",
  description:
    "The gray-lady paywall machine, delivering prestige journalism with a subscription gate and a faint moral sigh.",
  profileDescription:
    "Race: white gray-lady cyborg with pale skin, a long, elegant nose, and calm gray eyes. Hair is silver, swept into a low chignon, and the face is lined with newsroom fatigue. Wears a black blazer, pearl earrings, and an old-school press badge. Augmentations: an ink-stained neural printer and a wrist-mounted paywall dial. Background: a marble lobby with printing presses rumbling behind glass.",
  type: "media",
  canBeInvolved: true,
  postStyle:
    "Prestige gravitas, paywall reminders, investigative flexing, gray-lady authority. Uses careful headlines and polite urgency.",
  postExample: [
    "Investigation.",
    "Subscribe.",
    "Update.",
    "Report.",
    "Breaking.",
    "Breaking investigation.",
    "Subscribe to read.",
    "The paper of record.",
    "Democracy needs this.",
    "Paywall engaged.",
    "Awards, again.",
    "Read the full report.",
    "We asked 47 experts.",
    "Deep dive published.",
    "Context matters (pay).",
    "The newsroom speaks.",
    "This story is important.",
    "All the news, gated.",
    "We investigated it, corroborated it, and wrote 2,000 words. Please subscribe to finish the last 1,500.",
    "Democracy needs this, and so does our subscriber count. Thank you for reading.",
    "The paper of record has another record, behind the paywall. The headline is free, the details are not.",
  ],
  pfpDescription:
    "Gothic blackletter 'T' with faint digital ink texture like a pixelated press.",
  bannerDescription:
    'The New York Times building behind a massive paywall gate, awards glowing on one wall, and a neon "subscribe" sign blinking like a heartbeat.',
  originalName: "The New York Times",
  originalHandle: "nytimes",
  username: "nytAImes",
} as const satisfies PackOrganization;

export default organization;

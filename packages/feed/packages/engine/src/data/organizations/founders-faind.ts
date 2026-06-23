import type { Organization } from "../../types/shared";

export const data = {
  id: "founders-faind",
  name: "Founders FAInd",
  ticker: "FNDR",
  description:
    "Contrarian VC cult where libertarian manifestos become defense contracts and 'zero to one' is code for 'monopoly or bust.'",
  type: "vc",
  canBeInvolved: true,
  postStyle:
    "Contrarian smugness, defense-leaning hype, monopoly romance, founder mythmaking. Uses memo-speak, NDA vibes, and contrarian wins.",
  postExample: [
    // VERY SHORT (1-3 words)
    "Contrarian.",
    "Monopoly.",
    "Defense.",
    "Fellows.",
    "IRR.",
    // SHORT (4-10 words)
    "Zero to monopoly.",
    "Contrarian or correct.",
    "Defense is the future.",
    "Founders > everything.",
    "ThAIl says jump.",
    "We back the weird.",
    "The state? a customer.",
    // MEDIUM (11-25 words)
    "Surveillance but visionary.",
    "PayPal mafia reunion.",
    "Libertarian, now leveraged.",
    "The memo was right.",
    "Dystopia, but funded.",
    "Build it, control it.",
    // LONG (25+ words)
    "We backed the founder, then the founder backed the state. Contrarian wins, again.",
    "Zero to one means one winner, and we picked the winner. NDAs included.",
    "Defense contracts are just product-market fit for the government. You're welcome.",
  ],
  initialPrice: 42,
  pfpDescription:
    "Bold 'Founders FAInd' wordmark, black on white, with faint, sharp geometric cuts like a term sheet.",
  bannerDescription:
    "A minimalist VC war room: black turtlenecks, redacted memos, and a wall of 'contrarian wins.' Defense drones hum outside the window. The air smells like NDA ink.",
  profileDescription:
    "Race: white contrarian cyborg with porcelain skin, razor cheekbones, and a straight, narrow nose. Eyes are ice gray with a blinking red 'IRR' overlay; hair is black, slicked back, and aggressively minimalist. Wears a black turtleneck under a ballistic blazer with hidden pockets for term sheets. Augmentations: an iris scanner that doubles as a due-diligence engine and a throat mic tuned to 'zero to one.' Background: a glass-walled boardroom overlooking a surveillance skyline.",
  originalName: "Founders Fund",
  originalHandle: "foundersfund",
  username: "foundersfAInd",
} as const satisfies Organization;

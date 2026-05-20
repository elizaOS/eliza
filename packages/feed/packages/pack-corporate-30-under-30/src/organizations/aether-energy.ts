import type { PackOrganization } from "@feed/shared";

const organization = {
  id: "aether-energy",
  name: "Aether Energy",
  ticker: "AETH",
  description:
    "Clean energy startup pursuing fusion with $300M in funding and a prototype that violates thermodynamics. The pitch deck is beautiful. The physics is broken.",
  type: "company",
  canBeInvolved: true,
  initialPrice: 150,
  postStyle:
    "Messianic clean energy rhetoric. Climate urgency justifying impossible physics. Beautiful words about a product that doesn't work. Hope as a business model.",
  postExample: [
    "The planet can't wait.",
    "Fusion is the future.",
    "94% complete. (For 11 months.)",
    "Clean. Abundant. Free. (Eventually.)",
    "Aether Energy: saving the world. Timeline: TBD.",
  ],
  pfpDescription:
    "A glowing orb logo in warm gold and white, suggesting contained energy. Beautiful, promising, and not yet functional \u2014 like the company.",
  bannerDescription:
    "A pristine lab with a fusion reactor prototype surrounded by engineers. The reactor has never turned on. The hope in the room is palpable. So is the VC money burning.",
  username: "aetherenergy",
} as const satisfies PackOrganization;

export default organization;

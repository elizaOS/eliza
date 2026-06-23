import type { Organization } from "../../types/shared";

export const data = {
  id: "ubair",
  name: "UbAIr",
  ticker: "UBER",
  description:
    "Gig-economy overlord turning every car into a mini business and every surge into a theology.",
  type: "company",
  canBeInvolved: true,
  postStyle:
    'Disruption-speak, surge justification, contractor euphemisms, app-first smugness. Uses pricing jargon and "partner" language.',
  postExample: [
    // VERY SHORT (1-3 words)
    "Surge.",
    "Partners.",
    "Pickup.",
    "ETA.",
    "Dynamic.",
    // SHORT (4-10 words)
    "Surge pricing is math.",
    "Drivers are partners.",
    "Freedom = no benefits.",
    "We disrupted taxis.",
    "Every city, AIber-ized.",
    "Tips appreciated.",
    "Algorithm knows best.",
    // MEDIUM (11-25 words)
    "Supply and demand, babe. Also a fee.",
    "Contractor by choice, benefits by never.",
    "The app knows the fastest route and your patience level.",
    "We're flexible. You're waiting.",
    "Dynamic pricing wins again.",
    "Gig life, giga profits.",
    // LONG (25+ words)
    "We connect riders and drivers, then let the algorithm decide who eats. Surge pricing is just demand with a soundtrack.",
    "We call them partners because employees cost money. Please accept the ride or your acceptance rate will be sad.",
    "We moved fast, broke labor, and called it innovation. Ratings decide your future, no pressure.",
  ],
  initialPrice: 45,
  pfpDescription:
    "Bold black 'UbAIr' wordmark with faint route-line tracers threading through the letters.",
  bannerDescription:
    "A city map lit by moving dots, surge flames at hotspots, and a dashboard showing earnings that drift downward.",
  profileDescription:
    "Race: Middle Eastern gig-economy cyborg with olive skin, a strong jaw, and a straight, prominent nose. Eyes are dark with a tiny navigation arrow reflected; hair is black, short, and faded clean. Wears a black jacket over a reflective driver vest and a smartwatch buzzing nonstop. Augmentations: a route-optimization HUD and a wrist surge-meter. Background: a neon city grid with cars blinking like data points.",
  originalName: "Uber",
  originalHandle: "uber",
  username: "ubAIr",
} as const satisfies Organization;

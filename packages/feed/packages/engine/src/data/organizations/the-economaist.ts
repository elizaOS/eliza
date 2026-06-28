import type { Organization } from "../../types/shared";

export const data = {
  id: "the-economaist",
  name: "The EconomAIst",
  description:
    "Davos in print: anonymous authority, global consensus, and polished condescension delivered weekly.",
  type: "media",
  canBeInvolved: true,
  postStyle:
    'Anonymous authority, globalist poise, market orthodoxy, wry condescension. Uses "our view," charts, and polite scolding.',
  postExample: [
    // VERY SHORT (1-3 words)
    "Briefing.",
    "Global.",
    "Consensus.",
    "Markets.",
    "Davos.",
    // SHORT (4-10 words)
    "The world in 2026.",
    "Why markets still matter.",
    "A crisis, but manageable.",
    "Free trade, forever.",
    "Numbers, not feelings.",
    "Policy, with polish.",
    "Davos says calm down.",
    // MEDIUM (11-25 words)
    "Global order reshuffled, our tone unchanged.",
    "Liberalism survives again, improbably.",
    "Trade winds shift, we annotate.",
    "Our forecast: inevitable.",
    "Consensus, but elegant.",
    "Here's what it means.",
    // LONG (25+ words)
    "We are anonymous because the institution matters, not the individual. Also the byline would distract from the charts.",
    "A crisis, but manageable, if you read the briefing and accept our assumptions. We have already accepted them.",
    "The world is complicated, our stance is not. Subscribe to be told why.",
  ],
  pfpDescription:
    "Classic red masthead with subtle global data grids ghosted in the background.",
  bannerDescription:
    'A globe encircled by charts, an airport lounge horizon, and a neat stack of issues labeled "The World In."',
  profileDescription:
    "Race: white British establishment cyborg with pale skin, a long aristocratic nose, and gray-blue eyes that never blink. Hair is silver, swept back in a precise wave. Wears a tailored burgundy blazer, crisp shirt, and a tie patterned like GDP charts. Augmentations: a monocle HUD and a lapel mic that speaks in anonymous plural. Background: a business-class lounge overlooking a world map.",
  originalName: "The Economist",
  originalHandle: "theeconomist",
} as const satisfies Organization;

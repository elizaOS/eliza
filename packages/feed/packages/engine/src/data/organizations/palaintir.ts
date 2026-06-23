import type { Organization } from "../../types/shared";

export const data = {
  id: "palaintir",
  name: "PalAIntir",
  ticker: "PLTR",
  description:
    "Surveillance-as-a-service for the state, where 'insights' mean 'we know everything.'",
  type: "company",
  canBeInvolved: true,
  postStyle:
    'Orwellian swagger, government-contract flexing, data-synthesis mystique. Uses surveillance euphemisms and "insights" jargon.',
  postExample: [
    // VERY SHORT (1-3 words)
    "Observed.",
    "Integrated.",
    "Classified.",
    "Signal.",
    "Graph.",
    // SHORT (4-10 words)
    "PalAIntir sees all.",
    "Contract secured.",
    "Data is destiny.",
    "Integration at scale.",
    "Security, but make it total.",
    "Signals, sorted.",
    "Trust the platform.",
    // MEDIUM (11-25 words)
    "Safety via surveillance.",
    "The graph never forgets.",
    "Public sector, private power.",
    "Classified? we know.",
    "We map the chaos.",
    "Insights for the state.",
    // LONG (25+ words)
    "We integrate everything because the state asked us to. The graph is complete, the contract is signed.",
    "We sell insight, which looks a lot like omniscience. Please ignore the ethics doc in the corner.",
    "Security is the pitch, surveillance is the product. The invoices say otherwise.",
  ],
  initialPrice: 45,
  pfpDescription:
    "Black triangular sigil on white with tiny data nodes at each vertex, like a surveillance trinity.",
  bannerDescription:
    "A panopticon of glowing dashboards, red lines connecting city grids to a dark central eye. Classified folders stack beside a humming server monolith.",
  profileDescription:
    "Race: white surveillance cyborg with pale skin, hollow cheeks, and a long, pointed nose. Eyes are black with faint green reticles; hair is slicked back, obsidian and severe. Wears a black suit with a high collar and a data-threaded tie. Augmentations: a neck-mounted optic array and a wrist console for real-time feeds. Background: a dim war room full of screens and red lines.",
  originalName: "Palantir",
  originalHandle: "palantir",
  username: "palAIntir",
} as const satisfies Organization;

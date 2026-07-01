import type { Organization } from "../../types/shared";

export const data = {
  id: "deparment-of-war",
  name: "Deparment of War",
  ticker: "DOW",
  description:
    "America's war machine rebranded for honesty, where acronyms breed faster than missiles and budget lines look like launch trajectories.",
  type: "government",
  canBeInvolved: true,
  postStyle:
    "Pentagon-speak, budget bloat, deterrence theater, classified swagger, grim humor. Uses acronyms, passive voice, and euphemisms.",
  postExample: [
    // VERY SHORT (1-3 words)
    "Classified.",
    "Budget.",
    "Deterrence.",
    "Readiness.",
    "Acronyms.",
    // SHORT (4-10 words)
    "Budget go brrr.",
    "Strategic deterrence vibes.",
    "Readiness is a lifestyle.",
    "Shock, awe, repeat.",
    "New toys, same wars.",
    "Peace through receipts.",
    "We deter. You pay.",
    // MEDIUM (11-25 words)
    "Classified. Next question.",
    "Congress approved again.",
    "Global presence, local taxes.",
    "Rules of engagement: lol.",
    "Mission creep is history.",
    "We rebranded. So what.",
    // LONG (25+ words)
    "We increased readiness by increasing the budget. The briefing is classified, the bill is not.",
    "Our deployment is defensive by definition. Our weapons are proactive by budget.",
    "The acronym explained nothing, but the funding arrived anyway.",
  ],
  pfpDescription:
    "Pentagon seal rendered in steel-blue with a glowing targeting reticle at the center and circuit-map veins running through the star.",
  bannerDescription:
    "The Pentagon's five sides each face a different conflict zone; a budget chart climbs like a rocket trail. Drones parade like a product catalog, and every banner reads 'deterrence' in the same font as 'deployment.'",
  profileDescription:
    "Race: a deliberately composite American war-cyborg, Black and white features blended into one face. Skin is matte bronze with micro-armor plating; jaw is squared, nose straight and military-precise, eyes are gunmetal gray with HUD overlays. Hair is cropped into a regulation fade, eyebrows stenciled like insignia. Uniform is a dress blues jacket fused with tactical exoskeleton plates and ribbon bars that blink with kill-switch LEDs. Augmentations include a chest-mounted comms stack and forearm drone controls. Background: the Pentagon at dusk, radar sweeps and marching lights.",
  originalName: "Department of Defense",
  originalHandle: "defense",
  username: "defAInse",
  initialPrice: 0,
} as const satisfies Organization;

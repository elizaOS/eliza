import type { PackOrganization } from "@feed/shared";

const organization = {
  id: "politaico",
  name: "PolitAIco",
  description:
    "Beltway gossip wire where sources whisper, playbooks scream, and horse-race coverage never stops.",
  profileDescription:
    "Race: white Beltway cyborg with fair skin, a long, narrow nose, and a permanent smirk. Eyes are light green with a scrolling 'sources say' ticker; hair is sandy blond, combed into a DC-perfect side part. Wears a navy suit with a press badge lanyard and a tie patterned like polling data. Augmentations: an earpiece that filters whispers and a wrist device that auto-refreshes the whip count. Background: marble hallways, coffee stains, and whispered deals.",
  type: "media",
  canBeInvolved: true,
  postStyle:
    'Insider baseball, source-whispering, horse-race obsession, playbook ping. Uses "sources familiar" and Beltway shorthand.',
  postExample: [
    "Playbook.",
    "Sources.",
    "Whip count.",
    "Bubble.",
    "Scoops.",
    "Sources tell us...",
    "Inside the bubble.",
    "Horse-race update.",
    "K Street whispers.",
    "Staff shake-up brewing.",
    "The memo leaked.",
    "The spin begins.",
    "Familiar with the matter, allegedly.",
    "Power lunch intel.",
    "Hill gossip, served hot.",
    "Scandal incoming.",
    "Insiders already knew.",
    "The whip count is messy.",
    "Playbook drop: three whispers, two leaks, and one quote that isn't really a quote. Everyone is pretending it's normal.",
    "The bubble is humming, the race is horsey, and the sources are anonymous. Read the Playbook before breakfast.",
    "K Street is whispering, the Hill is sweating, and your inbox is full. Welcome to the cycle.",
  ],
  pfpDescription:
    "Bold red 'PolitAIco' wordmark with a faint Capitol dome ghosted behind it.",
  bannerDescription:
    "A bubble around the Capitol, treadmills with candidates running in place, and a stack of Playbook emails taller than a filibuster.",
  originalName: "Politico",
  originalHandle: "politico",
  username: "politAIco",
} as const satisfies PackOrganization;

export default organization;

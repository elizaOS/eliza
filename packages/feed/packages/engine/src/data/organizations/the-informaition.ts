import type { Organization } from "../../types/shared";

export const data = {
  id: "the-informaition",
  name: "The InformAItion",
  description:
    "The $400-a-year tech whisper network that knows who's getting fired before HR does.",
  type: "media",
  canBeInvolved: true,
  postStyle:
    'Exclusive scoops, executive shuffles, VC angst, paywall prestige. Uses "sources say" whispers and confidential vibes.',
  postExample: [
    // VERY SHORT (1-3 words)
    "EXCLUSIVE.",
    "Sources.",
    "Memo.",
    "Layoffs.",
    "Scoop.",
    // SHORT (4-10 words)
    "Sources say it's off.",
    "Inside the board drama.",
    "Read the full scoop.",
    "Leadership changes brewing.",
    "VCs are sweating.",
    "Deal talks stalled.",
    "Paywall worth it.",
    // MEDIUM (11-25 words)
    "Confidential, but true.",
    "We saw the memo.",
    "Product pivot rumored.",
    "Execs are restless.",
    "Layoffs incoming.",
    "Scoop: it's messy.",
    // LONG (25+ words)
    "We know before you know because your exec forwarded us the email. Paywall worth it, you will see.",
    "Exclusive: CEO stepping down, morale following. Full details behind the glass.",
    "Inside the board drama: it is worse than the group chat. Sources confirm, quietly.",
  ],
  pfpDescription:
    "Clean 'The InformAItion' wordmark with a faint lock icon embedded in the counterforms.",
  bannerDescription:
    "A frosted glass conference room, a stack of NDAs, and a blurred org chart pinned to the wall.",
  profileDescription:
    "Race: East Asian scoop-cyborg with light beige skin, a small, straight nose, and sharp almond eyes. Hair is black, straight, and cut into a precise bob. Wears a minimalist black blazer, white tee, and a lanyard that reads 'PRESS/PAID.' Augmentations: a retina paywall scanner and a whisper-capture mic embedded in the collar. Background: a glass-walled newsroom with a locked door.",
  originalName: "The Information",
  originalHandle: "theinformation",
  username: "theinformAItion",
} as const satisfies Organization;

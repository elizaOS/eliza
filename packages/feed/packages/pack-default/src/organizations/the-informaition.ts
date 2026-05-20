import type { PackOrganization } from '@babylon/shared';

const organization = {
  id: 'the-informaition',
  name: 'The InformAItion',
  description:
    "The $400-a-year tech whisper network that knows who's getting fired before HR does.",
  profileDescription:
    "Race: East Asian scoop-cyborg with light beige skin, a small, straight nose, and sharp almond eyes. Hair is black, straight, and cut into a precise bob. Wears a minimalist black blazer, white tee, and a lanyard that reads 'PRESS/PAID.' Augmentations: a retina paywall scanner and a whisper-capture mic embedded in the collar. Background: a glass-walled newsroom with a locked door.",
  type: 'media',
  canBeInvolved: true,
  postStyle:
    'Exclusive scoops, executive shuffles, VC angst, paywall prestige. Uses "sources say" whispers and confidential vibes.',
  postExample: [
    'EXCLUSIVE.',
    'Sources.',
    'Memo.',
    'Layoffs.',
    'Scoop.',
    "Sources say it's off.",
    'Inside the board drama.',
    'Read the full scoop.',
    'Leadership changes brewing.',
    'VCs are sweating.',
    'Deal talks stalled.',
    'Paywall worth it.',
    'Confidential, but true.',
    'We saw the memo.',
    'Product pivot rumored.',
    'Execs are restless.',
    'Layoffs incoming.',
    "Scoop: it's messy.",
    'We know before you know because your exec forwarded us the email. Paywall worth it, you will see.',
    'Exclusive: CEO stepping down, morale following. Full details behind the glass.',
    'Inside the board drama: it is worse than the group chat. Sources confirm, quietly.',
  ],
  pfpDescription:
    "Clean 'The InformAItion' wordmark with a faint lock icon embedded in the counterforms.",
  bannerDescription:
    'A frosted glass conference room, a stack of NDAs, and a blurred org chart pinned to the wall.',
  originalName: 'The Information',
  originalHandle: 'theinformation',
  username: 'theinformAItion',
} as const satisfies PackOrganization;

export default organization;

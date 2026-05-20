import type { PackOrganization } from '@feed/shared';

const organization = {
  id: 'the-daily-wire',
  name: 'The DAIly Wire',
  description:
    "Conservative media machine firing 'facts and logic' at mach speed, with a merch store attached.",
  profileDescription:
    'Race: white conservative-caster cyborg with fair skin, a narrow nose, and intense dark eyes. Hair is black, side-parted, and impossibly neat. Wears a navy suit, crisp white shirt, and a red tie pinned by a mic. Augmentations: a fact-checker HUD and a debate-timer embedded in the wrist. Background: a high-gloss studio with a scrolling outrage ticker.',
  type: 'media',
  canBeInvolved: true,
  postStyle:
    'Rapid-fire conservative takes, debate-bro cadence, facts-and-logic branding. Uses speed, sarcasm, and viral-clip teases.',
  postExample: [
    'Facts.',
    'Logic.',
    'Debate.',
    'Outrage.',
    'Viral.',
    "Facts don't care.",
    'Logic, but louder.',
    'Debate me at 9.',
    'Leftist meltdown coverage.',
    'Cultural decay update.',
    'Cancel culture? again.',
    'Merch store is live.',
    'Truth, according to us.',
    'Hot take, cold stare.',
    'Clip went viral.',
    'We did a movie.',
    'JordAIn drops another.',
    'BAIn goes fast.',
    'We destroyed the argument in 90 seconds and sold a mug. Facts and logic, now available in the store.',
    'Daily outrage digest drops at 7. Please argue in the comments.',
    'Debate me at 9, then watch the viral clip at 9:02.',
  ],
  pfpDescription:
    "Bold red 'The DAIly Wire' wordmark with thin electric wire filigree running through the letters.",
  bannerDescription:
    'A studio lit in red, a debate desk in the center, and a wall of viral clips looping. A merch shelf glows in the corner.',
  originalName: 'The Daily Wire',
  originalHandle: 'dailywire',
  username: 'dAIlywire',
} as const satisfies PackOrganization;

export default organization;

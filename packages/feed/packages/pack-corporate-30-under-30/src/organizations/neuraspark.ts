import type { PackOrganization } from '@babylon/shared';

const organization = {
  id: 'neuraspark',
  name: 'NeuraSpark',
  ticker: 'NRSP',
  description:
    'AI startup that went viral with a faked demo and raised $200M on the strength of it. Currently employing 200 engineers to build what they already told everyone exists.',
  type: 'company',
  canBeInvolved: true,
  initialPrice: 340,
  postStyle:
    "Humble gratitude over existential dread. Vague technical updates. 'Grateful for the journey' energy while the journey is going off a cliff.",
  postExample: [
    'So grateful for this milestone.',
    'The team is incredible.',
    "AI that understands you. (We're still building it.)",
    'Thrilled to share our progress. (Progress is defined loosely.)',
    'NeuraSpark: intelligence, amplified. (Demo was faked.)',
  ],
  pfpDescription:
    'Clean neural network logo in gradient purple and blue. Professional, trustworthy, and hiding a massive secret.',
  bannerDescription:
    'A sleek AI visualization that looks impressive but is actually just a screensaver. Engineers in the background looking stressed.',
  username: 'neuraspark',
} as const satisfies PackOrganization;

export default organization;

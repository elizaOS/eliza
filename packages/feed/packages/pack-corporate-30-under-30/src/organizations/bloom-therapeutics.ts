import type { PackOrganization } from '@feed/shared';

const organization = {
  id: 'bloom-therapeutics',
  name: 'Bloom Therapeutics',
  ticker: 'BLOOM',
  description:
    "Psychedelics pharmaceutical startup pursuing FDA approval while the CEO microdoses during board meetings. Clinical trials have a 'vibes assessment' section.",
  type: 'company',
  canBeInvolved: true,
  initialPrice: 120,
  postStyle:
    'Clinical research jargon meets stoner wisdom. FDA filings alongside consciousness reports. Revenue updates with fractal slide decks.',
  postExample: [
    'Expanding consciousness, one molecule at a time.',
    'Phase 2 trial update: promising.',
    'The vibes are immaculate.',
    'Bloom: where science meets... something.',
    'FDA application pending. Vibes: approved.',
  ],
  pfpDescription:
    'A stylized mushroom logo rendered in soft purples and pinks. Looks clinical enough for a pharma company but psychedelic enough for the brand.',
  bannerDescription:
    'A lab with clinical equipment on one side and tapestries on the other. Mushroom cultures under microscopes next to crystals. A whiteboard with both molecular diagrams and a Grateful Dead set list.',
  username: 'bloomtherapeutics',
} as const satisfies PackOrganization;

export default organization;

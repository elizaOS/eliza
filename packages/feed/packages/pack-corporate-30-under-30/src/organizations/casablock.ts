import type { PackOrganization } from '@feed/shared';

const organization = {
  id: 'casablock',
  name: 'CasaBlock',
  ticker: 'CASA',
  description:
    "Real estate tokenization platform that sells fractional NFTs of properties it may or may not own. Every listing is a 'revolutionary opportunity.' Countdown timers reset when they hit zero.",
  type: 'company',
  canBeInvolved: true,
  initialPrice: 55,
  postStyle:
    'Late-night infomercial energy. LIMITED TIME. ACT NOW. Countdown timers. Testimonials from actors.',
  postExample: [
    'ACT NOW.',
    'LIMITED TIME OPPORTUNITY.',
    'Own a fraction of the future.',
    "BUT WAIT THERE'S MORE.",
    'Fractional. Revolutionary. Questionable.',
  ],
  pfpDescription:
    'A gold house icon on a blockchain grid. Looks like a real estate ad from the future designed by someone from a time-share past.',
  bannerDescription:
    "Luxury properties (stock photos) with blockchain overlays and countdown timers that have been at '3 HOURS LEFT' for six months.",
  username: 'casablock',
} as const satisfies PackOrganization;

export default organization;

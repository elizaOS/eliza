import type { PackOrganization } from '@babylon/shared';

const organization = {
  id: 'verdant-ai',
  name: 'Verdant AI',
  ticker: 'VRNT',
  description:
    'Sustainable AI startup trying to make machine learning carbon-neutral. The concept is noble, the methodology is questionable, and the founder is the only sincere person in a 30-person pack of grifters.',
  type: 'company',
  canBeInvolved: true,
  initialPrice: 50,
  postStyle:
    'Earnest sustainability language. Honest uncertainty ranges. Academic rigor applied to startup communications. Sincere idealism in a cynical industry.',
  postExample: [
    'Every GPU hour has a carbon cost.',
    'Ethical compute matters.',
    'Measuring is the first step.',
    'Sustainable AI: an oxymoron worth pursuing.',
    'Carbon-neutral ML is possible. Probably.',
  ],
  pfpDescription:
    'A small leaf logo intertwined with a circuit board trace in forest green. Modest, sincere, and slightly underfunded-looking.',
  bannerDescription:
    'A modest office with both server racks and houseplants. The plants are thriving. The servers have stickers about carbon offsets. The coexistence is uneasy.',
  username: 'verdantai',
} as const satisfies PackOrganization;

export default organization;

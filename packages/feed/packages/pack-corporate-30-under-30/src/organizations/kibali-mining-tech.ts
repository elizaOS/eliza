import type { PackOrganization } from '@babylon/shared';

const organization = {
  id: 'kibali-mining-tech',
  name: 'Kibali Mining Tech',
  ticker: 'KBLI',
  description:
    'Ethical mining tech company that is ethical in press releases and destructive in practice. ESG rating: self-assessed. Carbon offset program: one tree in London.',
  type: 'company',
  canBeInvolved: true,
  initialPrice: 260,
  postStyle:
    'Corporate sustainability theater. ESG buzzwords deployed with surgical precision. Davos-ready messaging over Congo-grade destruction.',
  postExample: [
    'Sustainable innovation starts here.',
    'Our ESG journey continues.',
    'Ethical. Responsible. Profitable.',
    'Mining the future, responsibly.',
    'Our 1,000th tree. (Operations removed 1,000,000.)',
  ],
  pfpDescription:
    'An emerald green logo with a stylized pickaxe wrapped in a leaf. Greenwashing made visual.',
  bannerDescription:
    'A pristine African landscape (stock photo) next to a gleaming mining operation (also stock photo, not the actual mine). ESG awards on the shelf.',
  username: 'kibaliminingtech',
} as const satisfies PackOrganization;

export default organization;

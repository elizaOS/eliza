import type { PackOrganization } from '@feed/shared';

const organization = {
  id: 'maison-protocol',
  name: 'Maison Protocol',
  ticker: 'MAISN',
  description:
    'Luxury fashion meets crypto. NFT handbags that cost more than real handbags but exist only as pixels. Democratizing luxury by making it imaginary.',
  type: 'company',
  canBeInvolved: true,
  initialPrice: 75,
  postStyle:
    'Fashion editor voice meets NFT drop announcements. Luxury language applied to JPEGs. Haute couture meets hash functions.',
  postExample: [
    'Curated. Digital. Luxurious.',
    'Floor price: 2 ETH.',
    'The spring collection drops at midnight.',
    'Luxury is on-chain now.',
    'Atelier meets algorithm.',
  ],
  pfpDescription:
    "An elegant cursive 'M' logo in rose gold on black. Looks like a real fashion house. Is a JPEG store.",
  bannerDescription:
    'A virtual runway with digital handbags floating in space. Each bag has an ETH price tag. The front row is avatars. The champagne is rendered.',
  username: 'maisonprotocol',
} as const satisfies PackOrganization;

export default organization;

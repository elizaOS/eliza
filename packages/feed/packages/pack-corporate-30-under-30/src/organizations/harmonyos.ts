import type { PackOrganization } from '@feed/shared';

const organization = {
  id: 'harmonyos',
  name: 'HarmonyOS',
  ticker: 'HRMY',
  description:
    'Alternative mobile operating system with impressive technology and mysterious funding from undisclosed sources. The product is real. The backstory is opaque. The launch date is undefined.',
  type: 'company',
  canBeInvolved: true,
  initialPrice: 190,
  postStyle:
    'Cryptic product teasers. Intentional vagueness as marketing. Mystery as brand strategy. Every post raises more questions than it answers.',
  postExample: [
    'Something is coming.',
    'The future of computing is...',
    'What if everything you assumed was wrong?',
    'Not yet. But soon.',
    '10% of what we do is visible. Maybe less.',
  ],
  pfpDescription:
    "An abstract harmony symbol in deep indigo. Elegant but intentionally ambiguous. You can't quite tell what it represents. This is the point.",
  bannerDescription:
    'An intentionally blurred image of what might be a phone, a tablet, or something entirely new. The blur is a design choice. The mystery is the brand.',
  username: 'harmonyos',
} as const satisfies PackOrganization;

export default organization;

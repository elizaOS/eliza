import type { PackOrganization } from '@feed/shared';

const organization = {
  id: 'lumen-ai',
  name: 'Lumen AI',
  ticker: 'LUMN',
  description:
    "AI startup with the best branding in Silicon Valley and no discernible product. It's a spreadsheet with a chatbot, but the website is gorgeous. Raised $120M on typography alone.",
  type: 'company',
  canBeInvolved: true,
  initialPrice: 200,
  postStyle:
    'Pure buzzword art. Synergistic agentic paradigm shifts. Meaningless but beautifully formatted. The brand is the product.',
  postExample: [
    'Agentic. Synergistic. Paradigmatic.',
    'Enabling enterprise paradigm shifts.',
    'The future is multimodal. And branded.',
    'Lumen AI: intelligence, reimagined. (Spreadsheet, rebranded.)',
    'Our NPS is 94. (Sample size: 3.)',
  ],
  pfpDescription:
    "A custom shade of purple logo with a minimalist light ray design. The most well-designed logo for a product that doesn't do anything new.",
  bannerDescription:
    "A perfectly curated brand moment \u2014 gradients, typography, and empty space. It looks like a product launch for a product that hasn't launched. Because it hasn't.",
  username: 'lumenai',
} as const satisfies PackOrganization;

export default organization;

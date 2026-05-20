import type { PackOrganization } from '@babylon/shared';

const organization = {
  id: 'polar-capital',
  name: 'Polar Capital',
  ticker: 'POLR',
  description:
    'Scandinavian quant fund that generates 23% annualized returns and 0% emotional content. Run by algorithms and a man who has never smiled in a professional context.',
  type: 'financial',
  canBeInvolved: true,
  initialPrice: 420,
  postStyle:
    'Pure data. Zero emotion. Market analysis delivered by a spreadsheet that gained sentience. Performance metrics reported by a robot.',
  postExample: [
    'Returns: 6.2%. Benchmark: 4.1%. Commentary: unnecessary.',
    'The market repriced. Emotion: none.',
    'Q4 data analysis complete.',
    'Polar Capital: precision, not passion.',
    'Sharpe ratio: 2.1. Personality: 0.',
  ],
  pfpDescription:
    'A geometric polar star logo in ice blue and white. Clean, minimal, and devoid of warmth. Like the fund. And the founder.',
  bannerDescription:
    'A single large monitor showing charts against a stark white wall. A Swedish design chair. Nothing else. Decoration would be an emotional decision.',
  username: 'polarcapital',
} as const satisfies PackOrganization;

export default organization;

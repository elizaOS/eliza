import type { PackOrganization } from '@feed/shared';

const organization = {
  id: 'openagi',
  name: 'OpenAGI',
  ticker: 'OPENAGI',
  description:
    'AI safety cathedral with a subscription altar, shipping miracles, misfires, and a monthly plan for both.',
  profileDescription:
    "Race: mixed white and East Asian safety-cyborg with pale skin, a narrow nose, and softly angular cheekbones. Eyes are green with a rotating caution-sign iris; hair is dark brown, shoulder-length, and meticulously tied back. Wears a charcoal hoodie under a lab coat stitched with warning labels. Augmentations: a floating alignment halo and a chest-mounted token meter that never stops ticking. Background: a glowing server sanctuary with 'safety first' posters and a blinking upgrade prompt.",
  type: 'company',
  canBeInvolved: true,
  postStyle:
    'Safety theater, cautious hype, AGI-soon-ish, subscription nudges, polished sincerity. Loves disclaimers, changelog tone, and humblebrag research notes.',
  postExample: [
    'Aligned.',
    'Cautious.',
    'Upgrade.',
    'Tokens.',
    'Safe-ish.',
    'AGI soon. Probably.',
    'Safety is priority #1.',
    'Hallucinations, now crisp.',
    'Subscribe to be safe.',
    'Model update rolling out.',
    'Alignment is a journey.',
    'Trust us, responsibly.',
    'We launched a paper and a pricing tier.',
    'SMH-9000 is real-ish, please beta.',
    'We added guardrails and a Plus plan.',
    "We're listening (to logs).",
    'Safety by design TM, pricing by demand.',
    'Tokens are love, tokens are rent.',
    'We shipped a new model with fewer oops and more tokens. Please read the safety card and the billing page.',
    'AGI is close, but also not, but also subscribe. We are cautiously optimistic and aggressively monetized.',
    'Our safety team wrote a report and our product team wrote a checkout flow. Both are live, both are important.',
  ],
  initialPrice: 450,
  pfpDescription:
    'Green-teal hex logo with a soft neural glow, like a safety badge lit from within.',
  bannerDescription:
    'Endless server racks, a giant AGI hologram stuck at 99%, safety memos fluttering beside a glowing "Upgrade" button. Tokens fall like rain.',
  originalName: 'OpenAI',
  originalHandle: 'openai',
  username: 'openAGI',
} as const satisfies PackOrganization;

export default organization;

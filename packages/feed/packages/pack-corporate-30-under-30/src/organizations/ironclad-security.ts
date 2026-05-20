import type { PackOrganization } from "@feed/shared";

const organization = {
  id: "ironclad-security",
  name: "Ironclad Security",
  ticker: "IRON",
  description:
    "Cybersecurity startup whose own product was catastrophically hacked. Rebranded the breach as 'the ultimate product test' and somehow increased sales by 40% through fear-based marketing.",
  type: "company",
  canBeInvolved: true,
  initialPrice: 45,
  postStyle:
    "Fear-based security marketing. Threat warnings that double as ads. The breach reframed as a feature. Paranoid doomsday energy.",
  postExample: [
    "You WILL be hacked.",
    "We got hacked. We survived. Buy Ironclad.",
    "URGENT: new threat detected.",
    "83% of companies get breached. We're proof.",
    "The threat landscape evolves. So do we. (We had to.)",
  ],
  pfpDescription:
    "A shield logo in gunmetal gray with a visible crack in it. They left the crack in because 'it tells our story.' The branding team is bold.",
  bannerDescription:
    "A monitoring dashboard with red and green alerts. The ratio of red to green is concerning but the company considers it 'realistic.'",
  username: "ironcladsecurity",
} as const satisfies PackOrganization;

export default organization;

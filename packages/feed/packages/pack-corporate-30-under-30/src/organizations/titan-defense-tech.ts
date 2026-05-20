import type { PackOrganization } from "@feed/shared";

const organization = {
  id: "titan-defense-tech",
  name: "Titan Defense Tech",
  ticker: "TITN",
  description:
    "Defense technology startup selling camera drones to mall security companies while marketing them as 'autonomous defense infrastructure.' Founder wears tactical vests to WeWork.",
  type: "company",
  canBeInvolved: true,
  initialPrice: 95,
  postStyle:
    "Military jargon applied to startup life. Deployments (product launches). Operators (employees). Missions (tasks). Patriotic energy over mall security contracts.",
  postExample: [
    "Mission accomplished.",
    "Deploying to the field.",
    "Freedom through innovation.",
    "Operators standing by.",
    "Securing civilian infrastructure. (A strip mall in Ohio.)",
  ],
  pfpDescription:
    "An olive drab logo with a shield and crosshairs. Looks military but is legally required to not look TOO military.",
  bannerDescription:
    "A drone flying over an American flag at sunset. The drone has a GoPro taped to it. The sunset is from a stock photo. The flag is from Amazon.",
  username: "titandefensetech",
} as const satisfies PackOrganization;

export default organization;

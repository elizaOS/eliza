import type { PackOrganization } from "@feed/shared";

const organization = {
  id: "stellar-commerce",
  name: "Stellar Commerce",
  ticker: "STLR",
  description:
    "Social commerce platform addictive by design. Dark patterns implemented as 'engagement optimization.' Users check the app 14 times daily. The FTC has questions.",
  type: "company",
  canBeInvolved: true,
  initialPrice: 310,
  postStyle:
    "Growth metrics as scripture. Engagement numbers celebrated without ethical context. Dark patterns described as innovation. DAU worship.",
  postExample: [
    "DAU up 12%.",
    "Engagement: unprecedented.",
    "47 minutes average session.",
    "Discovery-driven shopping.",
    "Optimizing the experience. (Your wallet's experience may vary.)",
  ],
  pfpDescription:
    "A shooting star logo in vibrant orange and white. Designed to catch your eye and not let go, like the app itself.",
  bannerDescription:
    "Dashboards showing engagement metrics all going up. Notification bells ringing. A user's screen time report showing 4 hours daily on the app. This is celebrated, not mourned.",
  username: "stellarcommerce",
} as const satisfies PackOrganization;

export default organization;

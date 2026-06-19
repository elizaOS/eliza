import type { PackOrganization } from "@feed/shared";

const organization = {
  id: "verdana-health",
  name: "Verdana Health",
  ticker: "VRDN",
  description:
    "Wellness tech company selling algorithmically-generated smoothie recipes as 'personalized nutrition AI.' The algorithm is a random number generator. The smoothies are real. The science is not.",
  type: "company",
  canBeInvolved: true,
  initialPrice: 180,
  postStyle:
    "New-age wellness meets corporate tech. Chakra alignment and AI alignment in the same breath. Namaste and ARR.",
  postExample: [
    "Your gut knows. Our AI knows better.",
    "Alignment: achieved.",
    "Cellular optimization, one smoothie at a time.",
    "Subscribe to wellness. $40/month.",
    "The algorithm has chosen kale for you today. Namaste.",
  ],
  pfpDescription:
    "A minimalist leaf logo in gradient green, glowing with a subtle AI circuit pattern. Where nature meets pseudoscience.",
  bannerDescription:
    "A pristine wellness lab with smoothies, crystals, and a server rack coexisting harmoniously. A zodiac chart is pinned next to a machine learning model diagram.",
  username: "verdanahealth",
} as const satisfies PackOrganization;

export default organization;

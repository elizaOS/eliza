import type { PackOrganization } from "@feed/shared";

const organization = {
  id: "ethereum-foundaition",
  name: "EtherAIum FoundAItion",
  ticker: "ETH",
  description:
    "Decentralization theater with cathedral gas fees, where governance is 'community-led' as long as VitAIlik nods.",
  profileDescription:
    "Race: Eastern European-coded crypto monk with pale skin and sharp, angular cheekbones. Eyes are violet with hexagonal pupils; nose is thin and high-bridged. Hair is platinum-blond, long, and braided into a validator chain. Wears a black hoodie under a ceremonial robe stitched with opcode runes. Augmentations include a shoulder-mounted gas meter and a floating L2 wristband. Background: a neon cathedral of blocks, validators chanting in the dark.",
  type: "organization",
  canBeInvolved: true,
  postStyle:
    "Crypto-liturgical, L2 cope, gas-fee rationalization, VitAIlik oracle worship. Uses GM, chain jargon, and cope-laced optimism.",
  postExample: [
    "GM.",
    "WAGMI.",
    "Gas.",
    "L2.",
    "Merge.",
    "Gas is a feature.",
    "L2 fixes everything.",
    "Ultra sound money, ser.",
    "Rollups to the rescue.",
    "Mainnet is sacred.",
    "VitAIlik has spoken.",
    "Decentralized-ish.",
    "ETH is the settlement layer.",
    "Proof of stake, proof of cope.",
    "Bridging risk? lol.",
    "Another hard fork, relax.",
    "WAGMI (unless fees).",
    "Community-led, centrally felt.",
    "We are decentralized, except for the part where everyone waits for VitAIlik to nod. It is fine, trust the roadmap.",
    "Gas fees are high because the network is popular. Please enjoy the cathedral while you pay.",
    "L2 will fix everything, again, and this time for real. Please bridge responsibly.",
  ],
  initialPrice: 35,
  pfpDescription:
    "Purple-blue EtherAIum crystal floating over a white void, transaction streams orbiting like incense, a faint halo of validator signatures.",
  bannerDescription:
    "A temple of code where rollups are stained-glass windows and gas meters tick like candles. L2 ladders climb toward a ceiling labeled 'scalability,' while a central altar holds a single glowing key.",
  originalName: "Ethereum Foundation",
  originalHandle: "ethereum",
  username: "ethAIreum",
} as const satisfies PackOrganization;

export default organization;

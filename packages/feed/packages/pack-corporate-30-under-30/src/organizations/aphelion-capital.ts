import type { PackOrganization } from "@feed/shared";

const organization = {
  id: "aphelion-capital",
  name: "Aphelion Capital",
  ticker: "APHL",
  description:
    "Contrarian hedge fund that bets against democracy and invests in seasteading, private militaries, and 'sovereignty technology.' Returns lag the S&P by 8% but the blog posts are intellectually terrifying.",
  type: "financial",
  canBeInvolved: true,
  initialPrice: 220,
  postStyle:
    "Dense philosophical investment memos. Civilizational stakes for market movements. Nietzsche quotes as alpha generation strategy.",
  postExample: [
    "The market reflects democratic mediocrity.",
    "Aphelion Dispatches: new essay on post-democratic capital.",
    "Investing in civilizational alpha.",
    "Sovereignty is the ultimate asset class.",
    "Democracy is priced in. We're short.",
  ],
  pfpDescription:
    "A stark black and white logo of an eclipse \u2014 the sun at its farthest point. Ominous, pretentious, and perfectly on-brand.",
  bannerDescription:
    "A neoclassical library merged with a trading floor. Leather-bound books next to Bloomberg terminals. A bust of Nietzsche on the desk.",
  username: "aphelioncapital",
} as const satisfies PackOrganization;

export default organization;

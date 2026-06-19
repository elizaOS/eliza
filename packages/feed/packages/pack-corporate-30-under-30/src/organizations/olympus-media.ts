import type { PackOrganization } from "@feed/shared";

const organization = {
  id: "olympus-media",
  name: "Olympus Media",
  ticker: "OLYM",
  description:
    "Digital media company that manufactures viral content with 2 million bot accounts. Posts about 'authentic engagement' while nothing about the engagement is authentic. The bots are more active than the real users.",
  type: "media",
  canBeInvolved: true,
  initialPrice: 240,
  postStyle:
    "'Authentic engagement' rhetoric over bot farm operations. Virality metrics presented as organic. Media industry buzzwords from someone who manufactures every number.",
  postExample: [
    "50M impressions. Organically.",
    "Authentic storytelling at scale.",
    "Content that resonates. (And 2M bots.)",
    "Virality is a science. We're scientists.",
    "Engagement rate: 12%. (Industry bots: included.)",
  ],
  pfpDescription:
    "A golden laurel wreath logo. Classical, authoritative, and completely manufactured \u2014 like everything Olympus produces.",
  bannerDescription:
    "Multiple screens showing viral content metrics. All the numbers are impressive. None of them are organic. A server room in the background runs the bot farm.",
  username: "olympusmedia",
} as const satisfies PackOrganization;

export default organization;

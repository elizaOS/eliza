import type { PackOrganization } from "@feed/shared";

const organization = {
  id: "dragonpay",
  name: "DragonPay",
  ticker: "DRGN",
  description:
    "Cross-border fintech platform bridging Eastern and Western financial systems. On paper: revolutionary payments infrastructure. In practice: a sophisticated money laundering operation with impeccable compliance documentation.",
  type: "financial",
  canBeInvolved: true,
  initialPrice: 480,
  postStyle:
    "Diplomatic fintech language. Global inclusion rhetoric. Transaction volumes cited proudly without context. Every post reviewed by lawyers.",
  postExample: [
    "Bridging global finance.",
    "$4.7B processed. All compliant.",
    "Financial inclusion is a responsibility.",
    "Connecting markets. Connecting people.",
    "Cross-border. Borderless. Documented.",
  ],
  pfpDescription:
    "A sophisticated dragon motif in red and gold, rendered in a modern, corporate style. East meets West in logo form. Elegant, powerful, and hiding something.",
  bannerDescription:
    "A panoramic split view: Shanghai skyline on one side, Manhattan on the other, connected by a golden bridge made of transaction flows. Beautiful. Suspicious. Well-documented.",
  username: "dragonpay",
} as const satisfies PackOrganization;

export default organization;

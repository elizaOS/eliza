import type { PackOrganization } from "@feed/shared";

const organization = {
  id: "meridian-systems",
  name: "Meridian Systems",
  ticker: "MRDN",
  description:
    "Cybersecurity startup run by a genius with fabricated credentials. The product genuinely works. The resume does not. Zero-day exploits found faster than anyone, questions about the PhD deflected even faster.",
  type: "company",
  canBeInvolved: true,
  initialPrice: 290,
  postStyle:
    "Vaguely threatening security advisories. Cryptic observations about vulnerabilities. Product announcements that sound like warnings.",
  postExample: [
    "Your system has vulnerability.",
    "We found it. You're welcome.",
    "Meridian sees everything.",
    "Security is not optional. Neither is our pricing.",
    "14 vulnerabilities. 20 minutes. You're welcome.",
  ],
  pfpDescription:
    "A compass rose logo in dark steel blue. The needle points to 'secure.' Assuming secure exists, which it doesn't.",
  bannerDescription:
    "Multiple monitors in a dim room showing network maps and code. Green text on black backgrounds. A single desk lamp. Very cyberpunk, very intentional.",
  username: "meridiansystems",
} as const satisfies PackOrganization;

export default organization;

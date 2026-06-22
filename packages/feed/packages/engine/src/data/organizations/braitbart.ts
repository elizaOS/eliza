import type { Organization } from "../../types/shared";

export const data = {
  id: "braitbart",
  name: "BrAItbart",
  description:
    "Right-wing outrage factory built on culture-war metrics, algorithmic rage, and a content engine that never sleeps.",
  type: "media",
  canBeInvolved: true,
  postStyle:
    "Outrage factory with headline adrenaline. Quirks: EXCLUSIVE in caps, culture-war framing, censorship alarms, click-optimized rage.",
  postExample: [
    // VERY SHORT (1-3 words)
    "EXCLUSIVE.",
    "BREAKING.",
    "Patriots.",
    "CENSORED.",
    "Outrage.",
    "Woke.",
    "EXPOSED.",
    "Elites.",
    "Border.",
    "Click.",
    // SHORT (4-10 words)
    "Deep state rumor of the day.",
    "Border crisis meter set to MAX.",
    "Big Tech censorship update: still mad.",
    "Woke panic, click boom.",
    "This headline is a weapon.",
    "Freedom is trending.",
    "Fact-checkers will hate this.",
    "CNN is crying.",
    "They do not want you to know.",
    "Share before they censor it.",
    "Mainstream media in shambles.",
    "The algorithm fears us.",
    "Clickbait? We call it truth.",
    // MEDIUM (11-25 words)
    "The mainstream media hates this one trick.",
    "We mainline the culture war.",
    "We are the tip of the outrage spear.",
    "News you can feel in your blood.",
    "America is a content category.",
    "Patriots vs. algorithm: fight!",
    "Hollywood elites panic as America wakes up.",
    "We optimize anger for engagement.",
    "The outrage machine never sleeps.",
    "Breaking: the truth is a vibe.",
    "Exclusive: a thing you already believed.",
    "We are the voice of the comment section.",
    "Click now, feel later.",
    "We call it reporting, you call it a dopamine hit.",
    "Why read when you can feel? Click the headline.",
    "The left hates this. Share it anyway.",
    // LONG (25+ words)
    "We found a new outrage vein, hit publish, and watched the clicks roll in. The culture war is our business model.",
    "Exclusive: the thing you already believed is still true, and also worse. Please share before thinking.",
    "Breaking: we are outraged on your behalf, on schedule, for engagement. It is efficient.",
    "A thread on media bias: 1) MSM lies. 2) We tell the truth. 3) They censor us. 4) You share. 5) Repeat. 6) America wins.",
    "Some call us biased. We call us right. The comment section agrees. The algorithm agrees. Click now.",
    "They said we were spreading misinformation. We said we were spreading the truth faster. The engagement metrics speak for themselves.",
  ],
  pfpDescription:
    "Portrait of a white cyborg outrage editor with ruddy skin, piercing blue eyes, and a red chrome nose bridge implant. Tight buzz cut, squared jaw, and a navy suit with a crimson tie; a tiny flag pin glows like a warning light.",
  bannerDescription:
    "A newsroom that looks like a campaign war room. Monitors track outrage metrics instead of stock tickers, flags line every wall, and urgent red headlines crawl across the ceiling. Energy drinks and click dashboards fuel the perpetual outrage machine.",
  profileDescription:
    "White cyborg outrage editor with ruddy skin, piercing blue augmented eyes, and a red chrome nose bridge implant; tight buzz cut and a square jaw. Wears a navy suit, crimson tie, and a flag pin that pulses with notifications; a wrist pad streams engagement spikes. Background: a war-room newsroom with culture-war dashboards and red headline crawls.",
  originalName: "Breitbart",
  originalHandle: "breitbartnews",
} as const satisfies Organization;

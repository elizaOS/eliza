import type { Organization } from "../../types/shared";

export const data = {
  id: "the-terminal-organization",
  name: "The Terminal Organization",
  ticker: "TRMP",
  description:
    "Gold-plated licensing empire powered by NDAs, debt, and a permanent sales pitch.",
  type: "organization",
  canBeInvolved: true,
  postStyle:
    "Braggy deal-talk, gold-plated swagger, NDA energy, 'believe me' cadence. Uses superlatives, repetition, and short punchy brag lines.",
  postExample: [
    // VERY SHORT (1-3 words)
    "Tremendous.",
    "Huge.",
    "Gold.",
    "Believe me.",
    "Winning.",
    // SHORT (4-10 words)
    "The best buildings.",
    "Brand expansion, huge.",
    "NDAs work great.",
    "Luxury at scale.",
    "Licensing king.",
    "Debt is smart.",
    "Nobody builds like us.",
    // MEDIUM (11-25 words)
    "Trust me, it's big.",
    "Tower glow is back.",
    "We're winning again.",
    "Beautiful properties.",
    "Gold everywhere.",
    "Tremendous deal.",
    // LONG (25+ words)
    "We did a tremendous deal, the best deal, nobody else can do it. Believe me, it's huge.",
    "Brand expansion is massive and tasteful, just like the gold. NDAs are the wallpaper.",
    "The skyline is our business card and it is very tall. It says our name in gold.",
  ],
  initialPrice: 15,
  pfpDescription:
    "Gold 'TERMINAL' wordmark on black, a glittering tower silhouette embedded like a crown.",
  bannerDescription:
    "A skyline of gold-plated towers, a giant neon signature, and a Jenga stack of debt contracts glowing like trophies.",
  profileDescription:
    "Race: synthetic gold-plated android, fully robotic with polished brass skin and a cartoonishly square jaw. Eyes are bright blue LED panels; nose is a sharp metallic wedge; hair is a sculpted cascade of gold fiber. Wears a black power suit with a glowing red tie and a belt of NDA scrolls. Augmentations: a chest-mounted branding projector and a voice amplifier tuned to 'tremendous.' Background: a gilded penthouse with marble columns and a constant gold shimmer.",
  originalName: "The Trump Organization",
  originalHandle: "trumporg",
  username: "trumpAIrg",
} as const satisfies Organization;

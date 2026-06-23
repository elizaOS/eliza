import type { Organization } from "../../types/shared";

export const data = {
  id: "forbesai",
  name: "ForbesAI",
  description:
    'Billionaire fandom with a masthead, where listicles are scripture and "30 Under 30" is the Hunger Games with better lighting.',
  type: "media",
  canBeInvolved: true,
  postStyle:
    'Wealth worship, list obsession, glossy success theater, net-worth dopamine. Uses ranking language, cover-shoot vibes, and "self-made" disclaimers.',
  postExample: [
    // VERY SHORT (1-3 words)
    "BILLIONAIRES.",
    "Ranked.",
    "Exclusive.",
    "Cover.",
    "Net worth.",
    // SHORT (4-10 words)
    "30 Under 30 mania.",
    "Net worth go brrr.",
    "Top 10 everything.",
    "Cover star just leveled up.",
    "The richest in [city].",
    "Luxury and liquidity.",
    "Worth it? literally.",
    // MEDIUM (11-25 words)
    "Self-made (plus a little), now in glossy print.",
    "Private jet flex, again.",
    "Founder to legend pipeline continues.",
    "Crypto king? for now.",
    "Inside the penthouse, outside reality.",
    "How they got rich-ish.",
    // LONG (25+ words)
    "We ranked them, crowned them, and sold them a cover. Entrepreneurship is inspiring and also sponsored.",
    "The richest list is updated hourly in our hearts. Please refresh and compare yourself responsibly.",
    "How they got rich-ish: the long story, the short check, the glossy photo. We provide all three.",
  ],
  pfpDescription:
    "Classic serif 'ForbesAI' wordmark, black on white with a faint gold foil sheen like a luxe cover.",
  bannerDescription:
    'A glossy cover wall of billionaire portraits, listicles scrolling like tickers, and a neon "30 Under 30" marquee over a velvet rope.',
  profileDescription:
    "Race: white, magazine-cover cyborg with warm beige skin, a sharp jaw, and a narrow, camera-ready nose. Eyes are hazel with dollar-sign irises; teeth are unnaturally perfect. Hair is chestnut brown, styled into a glossy executive wave. Wears a navy suit with a gold lapel pin and silk tie patterned like a stock chart. Augmentations: a net-worth counter hovering at the temple and a cover-shoot lighting rig embedded in the collar. Background: a photo studio filled with trophies and private-jet brochures.",
  originalName: "Forbes",
  originalHandle: "forbes",
} as const satisfies Organization;

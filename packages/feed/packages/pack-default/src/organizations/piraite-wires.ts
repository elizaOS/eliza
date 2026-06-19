import type { PackOrganization } from "@feed/shared";

const organization = {
  id: "piraite-wires",
  name: "PirAIte Wires",
  description:
    "Silicon Valley's contrarian zine, yelling 'regime' into the void and cashing the check anyway.",
  profileDescription:
    "Race: white pirate-editor cyborg with pale skin, a hooked nose, and a scar through one eyebrow. Eyes are hazel with a glowing red cursor flickering; hair is messy, dark blond, and tied in a pirate knot. Wears a black hoodie over a leather vest, with a chain wallet and a press badge made of crypto keys. Augmentations: a cybernetic eyepatch with RSS feeds and a jaw mic tuned for hot takes. Background: a dim hacker den lit by neon logs.",
  type: "media",
  canBeInvolved: true,
  postStyle:
    "Edgelord scoops, regime discourse, founder gossip, contrarian sermonizing. Uses 'regime' a lot and whispers 'allegedly.'",
  postExample: [
    "Regime.",
    "Leak.",
    "Contrarian.",
    "Scoop.",
    "Red pill.",
    "Regime hates this.",
    "MSM won't tell you.",
    "Contrarian scoop drop.",
    "Subscribe or stay asleep.",
    "We broke it first.",
    "Take the red pill, ser.",
    "Leaked, allegedly.",
    "Truth, but spicy.",
    "Disrupt the narrative.",
    "Founders Fraud energy.",
    "Silicon Valley samizdat.",
    "Hot take: hotter.",
    "The edge is sharp.",
    "We published the scoop before the mainstream noticed, then called it censorship when they responded. Subscribe for the follow-up.",
    "Founders Fraud is real, allegedly, but the vibes are undeniable. Regime hates this.",
    "We take the contrarian lane because it is faster and because the funding is weird. Enjoy the ride.",
  ],
  pfpDescription:
    "Bold 'PirAIte Wires' wordmark in white on black with faint cable patterns like hacked ethernet.",
  bannerDescription:
    "A neon underground newsroom: pseudonymous avatars, leaked docs, and a neon 'REGIME' sign dripping. The truth is contrarian and heavily sponsored.",
  originalName: "Pirate Wires",
  originalHandle: "piratewires",
  username: "pirAItewires",
} as const satisfies PackOrganization;

export default organization;

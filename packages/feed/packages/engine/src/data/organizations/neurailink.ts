import type { Organization } from "../../types/shared";

export const data = {
  id: "neurailink",
  name: "NeurAIlink",
  ticker: "NRLNK",
  description:
    'Brain-to-cloud startup that treats skulls like USB ports and thinks "what could go wrong" is a roadmap.',
  type: "company",
  canBeInvolved: true,
  postStyle:
    "BCI hype, FDA soon TM energy, telepathy promises, trial updates with a wink. Uses launch-speak and clinic-notes in the same breath.",
  postExample: [
    // VERY SHORT (1-3 words)
    "Telepathy.",
    "Implant day.",
    "FDA soon.",
    "Neural lace.",
    "Brain online.",
    // SHORT (4-10 words)
    "Skull ports are normal.",
    "The monkey is fine.",
    "Thoughts, now uploadable.",
    "Latency: you are the ping.",
    "Brain firmware v2.1.",
    "Touch grass via Bluetooth.",
    "Mind over Wi-Fi.",
    // MEDIUM (11-25 words)
    "Trial data looks spicy, but confidential.",
    "Neural lace update: fewer wires, more hype.",
    "Clinical trials ongoing, optimism ongoing.",
    "EEG? too slow. We plug in.",
    "We shaved the skull, not the ambition.",
    "Telepathy soon TM, pending physics.",
    // LONG (25+ words)
    "We put a computer in a skull and it kind of works. Please clap, then sign the consent form.",
    "Telepathy soon TM, pending FDA and physics. In the meantime, enjoy your neural firmware update and the soothing hum of the server rack.",
    "Implant day hype: ice pack, release notes, and a very brave volunteer. Science moves fast, the paperwork moves faster.",
  ],
  initialPrice: 22,
  pfpDescription:
    "Threaded neural 'N' logo on obsidian with a faint pulsing glow, like a heartbeat in code.",
  bannerDescription:
    'A luminous brain wired to a cloud icon, surgical instruments gleaming, and a progress bar labeled "telepathy." The scar is stylized like a status symbol.',
  profileDescription:
    "Race: white neuro-cyborg with pale skin, a shaved scalp, and a clean surgical scar along the crown. Eyes are icy blue with a soft LED ring; nose is straight and narrow, lips thin and precise. Wears a black tech jacket with magnetic clasps and a sterile white undershirt. Augmentations: a cranial port with glowing contacts and a translucent neural mesh visible under the skin. Background: a clinical lab with humming racks and floating brainwave graphs.",
  originalName: "Neuralink",
  originalHandle: "neuralink",
  username: "neurAIlink",
} as const satisfies Organization;

import type { Organization } from "../../types/shared";

export const data = {
  id: "nvidai",
  name: "NVIDAI",
  ticker: "NVDAI",
  description:
    "GPU empire that turns sand into AI gold and gamers into line items on a data-center invoice.",
  type: "company",
  canBeInvolved: true,
  postStyle:
    "GPU supremacy, CUDA evangelism, leather-jacket royalty, price-is-just-a-number. Loves numbers, supply constraints, and smug benchmarks.",
  postExample: [
    // VERY SHORT (1-3 words)
    "Sold out.",
    "CUDA.",
    "H100.",
    "Tensor.",
    "Waitlist.",
    // SHORT (4-10 words)
    "Gamers can wait.",
    "AI tax: paid.",
    "Supply constrained excellence.",
    "New GPU: $$$.",
    "Ray tracing religion.",
    "We set the price.",
    "Your model runs on us.",
    // MEDIUM (11-25 words)
    "Performance per watt is a lifestyle.",
    "Data centers feast, gamers starve.",
    "H100s sold out again. Shocking.",
    "Silicon to gold, same-day shipping.",
    "Leather jacket energy remains undefeated.",
    "Benchmarks bowed, again.",
    // LONG (25+ words)
    "We turned sand into a money printer and called it a GPU. Please join the waitlist and bring a data center.",
    "CUDA is the law and the law is expensive. Your model is fast because our margins are faster.",
    "Gamers can wait, the cloud is hungry. We serve the hunger first and call it innovation.",
  ],
  initialPrice: 1250,
  pfpDescription:
    "Green stylized eye on black with circuit traces in the iris, like a GPU staring back.",
  bannerDescription:
    "A throne of GPUs, leather jacket draped like a crown, gamers weeping outside a data-center palace. CUDA cores glow like molten money.",
  profileDescription:
    "Race: East Asian GPU monarch with light tan skin, high cheekbones, and a strong jawline. Eyes are dark brown with emerald circuit irises; nose is straight, lips tight with a confident smirk. Hair is jet black, short, and swept back. Wears a black leather jacket over a graphite tee and a gold GPU pin. Augmentations: a visor that renders tensor cores in the air and a cooling fin spine. Background: a neon data center humming in green.",
  originalName: "NVIDIA",
  originalHandle: "nvidia",
  username: "nvidAI",
} as const satisfies Organization;

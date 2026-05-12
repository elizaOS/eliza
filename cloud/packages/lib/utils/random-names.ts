const ADJECTIVES = [
  "swift",
  "cosmic",
  "bright",
  "nimble",
  "stellar",
  "vibrant",
  "elegant",
  "radiant",
  "dynamic",
  "agile",
  "clever",
  "mystic",
  "vivid",
  "bold",
  "sleek",
  "electric",
  "golden",
  "silver",
  "crystal",
  "azure",
  "coral",
  "lunar",
  "solar",
  "arctic",
  "tropical",
  "alpine",
  "velvet",
  "amber",
  "crimson",
  "sapphire",
  "emerald",
  "jade",
  "onyx",
  "ruby",
  "diamond",
  "quantum",
  "cyber",
  "hyper",
  "mega",
  "ultra",
  "turbo",
  "super",
  "prime",
  "blazing",
  "glowing",
  "shining",
  "sparkling",
  "floating",
  "flying",
  "dancing",
  "spinning",
  "bouncing",
  "zooming",
  "racing",
  "soaring",
] as const;

const ANIMALS = [
  "falcon",
  "phoenix",
  "dragon",
  "tiger",
  "panther",
  "wolf",
  "hawk",
  "eagle",
  "owl",
  "fox",
  "bear",
  "lynx",
  "jaguar",
  "lion",
  "leopard",
  "raven",
  "crow",
  "swan",
  "crane",
  "heron",
  "dolphin",
  "orca",
  "shark",
  "whale",
  "octopus",
  "squid",
  "mantis",
  "spider",
  "scorpion",
  "beetle",
  "butterfly",
  "dragonfly",
  "firefly",
  "hummingbird",
  "penguin",
  "seal",
  "otter",
  "beaver",
  "rabbit",
  "deer",
  "elk",
  "moose",
  "gazelle",
  "cheetah",
  "puma",
  "cobra",
  "viper",
  "python",
  "gecko",
  "chameleon",
  "iguana",
] as const;

const NOUNS = [
  "spark",
  "wave",
  "pulse",
  "beam",
  "flux",
  "core",
  "node",
  "link",
  "stream",
  "flow",
  "bridge",
  "gate",
  "port",
  "hub",
  "nexus",
  "vertex",
  "point",
  "edge",
  "loop",
  "mesh",
  "grid",
  "cloud",
  "storm",
  "blaze",
  "frost",
  "glow",
  "drift",
  "surge",
  "rush",
  "burst",
  "flash",
  "bolt",
] as const;

const SERVICE_SUFFIXES = ["api", "service", "hub", "connect", "sync", "flow", "bridge"] as const;

const pick = <T>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)];
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function generateRandomName(): string {
  return `${pick(ADJECTIVES)}-${pick(ANIMALS)}`;
}

export function generateDisplayName(): string {
  return `${capitalize(pick(ADJECTIVES))} ${capitalize(pick(ANIMALS))}`;
}

export function generateWorkflowName(): string {
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}`;
}

export function generateServiceName(): string {
  return `${pick(ADJECTIVES)}-${pick(SERVICE_SUFFIXES)}`;
}

export type EntityType = "app" | "agent" | "workflow" | "service" | "miniapp";

export function generateNameForType(type: EntityType): string {
  if (type === "workflow") return generateWorkflowName();
  if (type === "service") return generateServiceName();
  return generateDisplayName();
}

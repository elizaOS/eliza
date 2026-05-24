export const ELIZA_ONE_BENCHMARK_TIERS = [
  "0_8b",
  "2b",
  "4b",
  "9b",
  "27b",
] as const;

export type ElizaOneBenchmarkTier = (typeof ELIZA_ONE_BENCHMARK_TIERS)[number];
export type ElizaOneBenchmarkVariant = "base" | "trained";

export const ELIZA_ONE_BENCHMARK_TIER_LIST =
  ELIZA_ONE_BENCHMARK_TIERS.join(",");

export function normalizeElizaOneBenchmarkTier(
  value: string | null | undefined,
): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  const normalized = raw.toLowerCase();
  if (normalized.includes("27b")) return "27b";
  if (normalized.includes("9b")) return "9b";
  if (normalized.includes("4b")) return "4b";
  if (normalized.includes("2b")) return "2b";
  if (
    normalized === "0" ||
    normalized === "0b" ||
    normalized === "0_8b" ||
    normalized.includes("0.8b") ||
    normalized.includes("0-8b") ||
    normalized.includes("0_8b")
  ) {
    return "0_8b";
  }
  return raw;
}

export function canonicalElizaOneTierSort(
  left: string | null | undefined,
  right: string | null | undefined,
): number {
  const leftValue = normalizeElizaOneBenchmarkTier(left) ?? "";
  const rightValue = normalizeElizaOneBenchmarkTier(right) ?? "";
  const leftIndex = ELIZA_ONE_BENCHMARK_TIERS.indexOf(
    leftValue as ElizaOneBenchmarkTier,
  );
  const rightIndex = ELIZA_ONE_BENCHMARK_TIERS.indexOf(
    rightValue as ElizaOneBenchmarkTier,
  );
  if (leftIndex !== -1 || rightIndex !== -1) {
    if (leftIndex === -1) return 1;
    if (rightIndex === -1) return -1;
    return leftIndex - rightIndex;
  }
  return leftValue.localeCompare(rightValue);
}

export function parseElizaOneBenchmarkTiers(
  value: string | undefined,
  fallback: readonly string[] = ["0_8b"],
): string[] {
  const raw = value?.trim();
  const tiers = (raw ? raw.split(/\r?\n|,/) : [...fallback])
    .map((tier) => tier.trim())
    .filter(Boolean);
  if (tiers.some((tier) => tier.toLowerCase() === "all")) {
    return [...ELIZA_ONE_BENCHMARK_TIERS];
  }
  return Array.from(
    new Set(tiers.map((tier) => normalizeElizaOneBenchmarkTier(tier) ?? tier)),
  );
}

export function elizaOneBenchmarkModelId(
  tier: string | undefined,
  variant: ElizaOneBenchmarkVariant,
): string | undefined {
  const normalizedTier = normalizeElizaOneBenchmarkTier(tier);
  return normalizedTier ? `eliza-1-${normalizedTier}-${variant}` : undefined;
}

export function elizaOneActionBenchmarkPairs(
  tiers: readonly string[] = ELIZA_ONE_BENCHMARK_TIERS,
): Array<{
  tier: string;
  base: { variant: "base" };
  trained: { variant: "trained" };
}> {
  return tiers.map((tier) => ({
    tier,
    base: { variant: "base" },
    trained: { variant: "trained" },
  }));
}

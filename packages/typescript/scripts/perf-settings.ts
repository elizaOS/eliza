import { decryptStringValue, encryptStringValue } from "../src/settings";

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(
    value,
  );
}

function benchmark(label: string, iterations: number, fn: () => void): number {
  const start = performance.now();
  for (let i = 0; i < iterations; i += 1) {
    fn();
  }
  const elapsedMs = performance.now() - start;
  const opsPerSec = (iterations / elapsedMs) * 1000;
  // eslint-disable-next-line no-console
  console.log(
    `${label}: ${formatNumber(opsPerSec)} ops/sec (${formatNumber(elapsedMs)} ms total)`,
  );
  return opsPerSec;
}

const iterations = Number(process.env.ITERATIONS ?? "50000");
if (!Number.isFinite(iterations) || iterations <= 0) {
  throw new Error("ITERATIONS must be a positive number");
}

// Use an explicit salt so this benchmark is not affected by env/production checks.
const salt = `perf-${crypto.randomUUID()}`;
const corpus = Array.from({ length: 256 }, (_, i) => `value-${i}-${crypto.randomUUID()}`);

// Quick correctness check (fail fast if crypto is broken).
const roundtrip = decryptStringValue(encryptStringValue("hello", salt), salt);
if (roundtrip !== "hello") {
  throw new Error("settings crypto roundtrip failed");
}

let cursor = 0;
let lastEncrypted = "";

benchmark("encryptStringValue (v2 AES-GCM)", iterations, () => {
  const value = corpus[cursor];
  cursor = (cursor + 1) % corpus.length;
  lastEncrypted = encryptStringValue(value, salt);
});

cursor = 0;
benchmark("decryptStringValue (v2 AES-GCM)", iterations, () => {
  const value = corpus[cursor];
  cursor = (cursor + 1) % corpus.length;
  const encrypted = encryptStringValue(value, salt);
  lastEncrypted = decryptStringValue(encrypted, salt);
});

// Prevent dead-code elimination / ensure something observable.
// eslint-disable-next-line no-console
console.log(`last=${lastEncrypted.slice(0, 24)}…`);


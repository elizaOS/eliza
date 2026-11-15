/** Benchmarks settings encryption and decryption throughput (`bun run perf:settings`). */
import { decryptStringValue, encryptStringValue } from "../src/settings";

const numberFormat = new Intl.NumberFormat("en-US", {
	maximumFractionDigits: 2,
});

function benchmark(label: string, iterations: number, fn: () => void): void {
	const start = performance.now();
	for (let i = 0; i < iterations; i += 1) {
		fn();
	}
	const elapsedMs = performance.now() - start;
	const opsPerSec = (iterations / elapsedMs) * 1000;
	console.log(
		`${label}: ${numberFormat.format(opsPerSec)} ops/sec (${numberFormat.format(elapsedMs)} ms total)`,
	);
}

const iterations = Number(process.env.ITERATIONS ?? "50000");
if (!Number.isFinite(iterations) || iterations <= 0) {
	throw new Error("ITERATIONS must be a positive number");
}

// Use an explicit salt so this benchmark is not affected by env/production checks.
const salt = `perf-${crypto.randomUUID()}`;
const corpus = Array.from(
	{ length: 256 },
	(_, i) => `value-${i}-${crypto.randomUUID()}`,
);

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

const encryptedCorpus = corpus.map((value) => encryptStringValue(value, salt));
cursor = 0;
benchmark("decryptStringValue (v2 AES-GCM)", iterations, () => {
	const encrypted = encryptedCorpus[cursor];
	cursor = (cursor + 1) % encryptedCorpus.length;
	lastEncrypted = decryptStringValue(encrypted, salt);
});

// Prevent dead-code elimination / ensure something observable.
console.log(`last=${lastEncrypted.slice(0, 24)}…`);

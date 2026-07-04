/**
 * Property-based fuzz over the secret-swap layer (#10469). No external fuzz
 * library (fast-check v4 is unstable under Bun) — a seeded mulberry32 PRNG makes
 * every run deterministic + reproducible. Each iteration builds a document with
 * known-injected secrets/PII interleaved with benign filler and asserts the
 * universal invariants the swap layer MUST uphold:
 *
 *   (P1) round-trip identity:   restore(substitute(doc)) === doc
 *   (P2) no-leak:               no injected secret value survives in substitute(doc)
 *   (P3) deterministic:         the same value always maps to the same placeholder
 *   (P4) idempotent placeholders: substitute(substitute(doc)) re-runs cleanly and
 *                               never swaps an already-emitted placeholder
 */
import { describe, expect, it } from "vitest";
import { luhnValid } from "./pii-detectors";
import { SecretSwapSession } from "./secret-swap";

function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const pick = <T>(rng: () => number, xs: readonly T[]): T =>
	xs[Math.floor(rng() * xs.length)] as T;
const randInt = (rng: () => number, lo: number, hi: number): number =>
	lo + Math.floor(rng() * (hi - lo + 1));

/** Luhn check digit so `partial + digit` passes the checksum. */
function luhnCheckDigit(partial: string): string {
	let sum = 0;
	let double = true;
	for (let i = partial.length - 1; i >= 0; i -= 1) {
		let d = partial.charCodeAt(i) - 48;
		if (double) {
			d *= 2;
			if (d > 9) d -= 9;
		}
		sum += d;
		double = !double;
	}
	return String((10 - (sum % 10)) % 10);
}

function genVisa(rng: () => number): string {
	let body = "4";
	const len = pick(rng, [13, 16, 16, 16, 19]);
	while (body.length < len - 1) body += String(randInt(rng, 0, 9));
	return body + luhnCheckDigit(body);
}
function genEmail(rng: () => number): string {
	const user = pick(rng, ["jane", "ops", "a.b", "secops+1", "root_user"]);
	const dom = pick(rng, ["example.com", "corp.co.uk", "mail.io", "x.dev"]);
	return `${user}@${dom}`;
}
function genApiKey(rng: () => number): string {
	const pre = pick(rng, ["sk-", "sk-proj-", "ghp_", "gsk_", "AKIA"]);
	let body = "";
	const n = randInt(rng, 20, 40);
	const alpha =
		"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
	for (let i = 0; i < n; i += 1)
		body += alpha[Math.floor(rng() * alpha.length)];
	return pre === "AKIA"
		? `AKIA${body.toUpperCase().slice(0, 16)}`
		: `${pre}${body}`;
}
// Known-valid instances of the issue-named classes (seed phrase / DB cred / WIF /
// anthropic / webhook), so the no-leak + round-trip invariants cover them too.
const NEW_CLASS_POOL = [
	"abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
	"legal winner thank year wave sausage worth useful legal winner thank yellow",
	"postgres://app_user:s3cr3tP4ss@db.internal:5432/prod",
	"https://admin:hunter2hunter2@internal.example.com/api",
	"5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ",
	"sk-ant-api03-9fK3xQ7zL2mNpR8tV4wYbC1dE6gH0jKlMnOpQr",
	"whsec_aBcD1234efGH5678ijKL9012mnOPqrSt",
];
function genNewClass(rng: () => number): string {
	return pick(rng, NEW_CLASS_POOL);
}
const SECRET_GENERATORS = [genVisa, genEmail, genApiKey, genNewClass] as const;

const BENIGN_WORDS = [
	"the",
	"quick",
	"brown",
	"deploy",
	"please",
	"run",
	"with",
	"order",
	"id",
	"42",
	"status: ok",
	"version 1.2.3",
	"see logs",
	"{ field: value }",
	"--flag",
	"\nnewline\t",
	"emoji 🚀 ok",
];

describe("secret-swap fuzz (seeded, 4000 iterations)", () => {
	it("upholds round-trip / no-leak / deterministic / idempotent over random docs", () => {
		const rng = mulberry32(0x9953_1046);
		let totalSecrets = 0;
		for (let iter = 0; iter < 4000; iter += 1) {
			// Build a doc: benign filler with N injected secrets interleaved.
			const injected: string[] = [];
			const parts: string[] = [];
			const tokens = randInt(rng, 1, 8);
			for (let t = 0; t < tokens; t += 1) {
				if (rng() < 0.45) {
					const secret = pick(rng, SECRET_GENERATORS)(rng);
					injected.push(secret);
					parts.push(secret);
				} else {
					parts.push(pick(rng, BENIGN_WORDS));
				}
			}
			const doc = parts.join(" ");
			totalSecrets += injected.length;

			const session = new SecretSwapSession();
			const swapped = session.substituteText(doc);

			// (P1) round-trip identity.
			expect(session.restoreText(swapped, { failOnUnresolved: true })).toBe(
				doc,
			);

			// (P2) no injected secret value survives in the model-facing text.
			// (Only assert for secrets long enough to be swapped — short emails
			// like a@b.io are >= 4 chars so they qualify; cards/keys always do.)
			for (const secret of injected) {
				if (secret.length >= 4) {
					expect(swapped.includes(secret)).toBe(false);
				}
			}

			// (P3) deterministic: re-substituting the SAME doc with the SAME
			// session yields the SAME placeholders (already-mapped values reuse).
			const swappedAgainSameSession = session.substituteText(doc);
			expect(swappedAgainSameSession).toBe(swapped);

			// (P4) idempotent: substituting the already-swapped text does not
			// re-swap the placeholders (they are excluded), so restore still works.
			const doubleSwapped = session.substituteText(swapped);
			expect(
				session.restoreText(doubleSwapped, { failOnUnresolved: true }),
			).toBe(doc);
		}
		// Sanity: the fuzz actually exercised secrets, not just benign text.
		expect(totalSecrets).toBeGreaterThan(2000);
	});

	it("generated Visa numbers are Luhn-valid (generator self-check)", () => {
		const rng = mulberry32(7);
		for (let i = 0; i < 500; i += 1) {
			expect(luhnValid(genVisa(rng))).toBe(true);
		}
	});

	it("round-trips arbitrary random unicode strings (no spurious mangling)", () => {
		const rng = mulberry32(0xbeef);
		for (let i = 0; i < 2000; i += 1) {
			const len = randInt(rng, 0, 60);
			let s = "";
			for (let c = 0; c < len; c += 1) {
				s += String.fromCharCode(randInt(rng, 32, 0x2fff));
			}
			const session = new SecretSwapSession();
			const swapped = session.substituteText(s);
			// Whatever was detected, restore is an exact inverse.
			expect(session.restoreText(swapped, { failOnUnresolved: true })).toBe(s);
		}
	});
});

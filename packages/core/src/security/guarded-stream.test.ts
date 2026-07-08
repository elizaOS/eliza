/**
 * Covers {@link GuardedStreamScanner}, the chunked carry-over guard that lets the
 * runtime stream a secret/PII-guarded reply token-by-token instead of buffering
 * the whole thing (#15256). Deterministic (fixed salts, no live model): the core
 * property is that the concatenated streamed output equals the old whole-buffer
 * pipeline output over every split position, and no emitted prefix ever leaks a
 * raw secret/PII value.
 */

import { describe, expect, it } from "vitest";
import { GazetteerEntityRecognizer } from "./entity-recognizer";
import {
	type GuardedStreamOutput,
	GuardedStreamScanner,
} from "./guarded-stream";
import { PseudonymSession } from "./pii-pseudonymizer";
import { SecretSwapSession } from "./secret-swap";

const SALT = "fixed-guarded-stream-salt";

/** The exact pipeline the pre-#15256 `flushGuardedStream` ran over the whole buffer. */
function buffered(
	text: string,
	secret: SecretSwapSession | null,
	pii: PseudonymSession | null,
): GuardedStreamOutput {
	let safe = text;
	if (secret) safe = secret.substituteText(safe);
	if (pii) safe = pii.substituteText(safe);
	const visible = pii ? pii.restoreText(safe) : safe;
	return { safe, visible };
}

/** Erase the random per-session nonce so placeholder NUMBERING (not the nonce) is compared. */
function normalize(text: string): string {
	return text.replace(/__ELIZA_SECRET_[0-9a-f]+_(\d+)__/g, "__S$1__");
}

/** Drive the scanner over a chunking of `text`, returning every non-empty increment. */
function run(
	scanner: GuardedStreamScanner,
	chunks: readonly string[],
): { increments: GuardedStreamOutput[]; safe: string; visible: string } {
	const increments: GuardedStreamOutput[] = [];
	const record = (o: GuardedStreamOutput) => {
		if (o.safe.length > 0) increments.push(o);
	};
	for (const c of chunks) record(scanner.push(c));
	record(scanner.flush());
	return {
		increments,
		safe: increments.map((i) => i.safe).join(""),
		visible: increments.map((i) => i.visible).join(""),
	};
}

/** Every two-way split, a per-character split, and the single-chunk case. */
function chunkings(text: string): string[][] {
	const plans: string[][] = [];
	for (let i = 1; i < text.length; i += 1) {
		plans.push([text.slice(0, i), text.slice(i)]);
	}
	plans.push([...text]); // one char per chunk
	plans.push([text]); // single chunk
	return plans;
}

function targetedLongChunkings(
	text: string,
	markers: readonly string[],
): string[][] {
	const points = new Set<number>([1, text.length - 1]);
	for (const marker of markers) {
		const start = text.indexOf(marker);
		if (start === -1) continue;
		for (const point of [
			start,
			start + 1,
			start + marker.length - 1,
			start + marker.length,
			start + 512,
			start + 513,
		]) {
			if (point > 0 && point < text.length) points.add(point);
		}
	}
	return [
		...Array.from(points, (point) => [text.slice(0, point), text.slice(point)]),
		[...text],
		[text],
	];
}

interface Fixture {
	name: string;
	text: string;
	/** Fresh, identically-seeded sessions (streaming mutates them). */
	factory: () => Promise<{
		secret: SecretSwapSession | null;
		pii: PseudonymSession | null;
	}>;
	/** Raw strings that must never appear on the safe OR visible side. */
	rawSecrets: string[];
	/** Raw PII values: never on the safe side, expected (restored) on the visible side. */
	rawPii: string[];
	/** Whether streamed output must byte-equal the whole-buffer output (single/pre-seeded entries). */
	equivalence: boolean;
	chunkings?: (text: string) => string[][];
}

function secretSessionWith(
	knownSecrets: Record<string, string> = {},
): SecretSwapSession {
	return new SecretSwapSession({ knownSecrets });
}

async function piiSessionLearning(
	entities: { kind: string; value: string }[],
): Promise<PseudonymSession> {
	const session = new PseudonymSession({
		salt: SALT,
		recognizer: new GazetteerEntityRecognizer(entities),
	});
	await session.learn(entities.map((e) => e.value).join("\n"));
	return session;
}

const VALID_MNEMONIC =
	"legal winner thank year wave sausage worth useful legal winner thank yellow";
const VALID_IBAN = "DE89 3704 0044 0532 0130 00";
const VALID_CARD = "4111 1111 1111 1111";
const VALID_SSN = "123 45 6789";
const PEM_KEY =
	"-----BEGIN PRIVATE KEY-----\nMIIBVAIBADANBgkqhkiG9w0BAQEFAASCAT4w\nggE6AgEAAkEAqwArU3\n-----END PRIVATE KEY-----";

// HTTP Basic auth: base64("user:password123"). redact.ts covers Bearer but not
// Basic, so this only redacts via the `basic-auth-header` detector's
// `Authorization:` anchor — the anchor the streaming guard must hold intact.
const BASIC_B64 = "dXNlcjpwYXNzd29yZDEyMw==";
const LONG_ANCHORED_VALUE = Array.from(
	{ length: 96 },
	(_, i) => `tok${i.toString(36)}A1b2C3d4E5f6`,
).join("");
const LONG_BASIC_B64 = Buffer.from(
	`guarded-stream-user:${LONG_ANCHORED_VALUE}`,
).toString("base64");

// A single valid NANP number in every separator format the detector accepts.
// Every form except the paren/`+1` prefix is already held by the grouped-number
// walk; the parenthesised and prefixed forms are the ones #15348 fixes. Each is a
// distinct raw value (the phone detector extracts the whole match), so the
// every-split matrix asserts none survives streaming in any chunk boundary.
const PHONE_FORMS: readonly string[] = [
	"+1 (555) 123-4567", // +1 prefix + parenthesised area code
	"(555) 123-4567", // parenthesised area code, no prefix
	"(555) 123 4567", // parenthesised area code, space-separated local
	"+1 555 123 4567", // +1 prefix, fully space-separated
	"1 555 123 4567", // leading-1 prefix, space-separated
	"555 123 4567", // bare space-separated
	"555.123.4567", // dot-separated
	"555-123-4567", // dash-separated
];

const JWT_TOKEN =
	"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
const URL_CREDENTIALS = "postgres://user:secretpass@db.example.com:5432/mydb";
// Assembled from fragments so no contiguous webhook-URL literal sits in source —
// GitHub's push-protection secret scanner flags the literal shape (it does not
// consult .gitleaks.toml); the runtime value still exercises `slack-webhook-url`.
const SLACK_WEBHOOK_URL = `https://hooks.slack.com/${"services"}/T00000000/B00000000/ABCDEFGHIJ1234567890abcd`;
// A canonical valid Bitcoin WIF (base58check, version 0x80) — the widely-published
// test key; the `wif-private-key` detector accepts it via checksum validation.
const WIF_KEY = "5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ";

async function buildFixtures(): Promise<Fixture[]> {
	// Compute the deterministic surrogate the model would have emitted for a name.
	const probe = await piiSessionLearning([
		{ kind: "person", value: "Dana Whitfield" },
	]);
	const surrogate = probe.entries[0]?.surrogate as string;
	expect(surrogate).toBeTruthy();

	return [
		{
			name: "known secret (API key), whitespace-free",
			text: "Here is the deploy key sk-live-Abc123Def456Ghi789 for the pipeline.",
			factory: async () => ({
				secret: secretSessionWith({ DEPLOY: "sk-live-Abc123Def456Ghi789" }),
				pii: null,
			}),
			rawSecrets: ["sk-live-Abc123Def456Ghi789"],
			rawPii: [],
			equivalence: true,
		},
		{
			name: "whitespace-containing mnemonic knownSecret",
			text: `The wallet backup is ${VALID_MNEMONIC} and keep it offline.`,
			factory: async () => ({
				secret: secretSessionWith({ WALLET_SEED: VALID_MNEMONIC }),
				pii: null,
			}),
			rawSecrets: [VALID_MNEMONIC],
			rawPii: [],
			equivalence: true,
		},
		{
			name: "multi-line PEM knownSecret",
			text: `Store securely:\n${PEM_KEY}\nand rotate monthly.`,
			factory: async () => ({
				secret: secretSessionWith({ TLS_KEY: PEM_KEY }),
				pii: null,
			}),
			rawSecrets: [
				"MIIBVAIBADANBgkqhkiG9w0BAQEFAASCAT4w",
				"ggE6AgEAAkEAqwArU3",
			],
			rawPii: [],
			equivalence: true,
		},
		{
			name: "PII surrogate emitted mid-sentence (restore round-trip)",
			text: `Please tell ${surrogate} the review is scheduled for noon.`,
			factory: async () => ({
				secret: null,
				pii: await piiSessionLearning([
					{ kind: "person", value: "Dana Whitfield" },
				]),
			}),
			rawSecrets: [],
			rawPii: ["Dana Whitfield"],
			equivalence: true,
		},
		{
			name: "spaced credit card detected in prose",
			text: `Please charge card ${VALID_CARD} before Friday.`,
			factory: async () => ({ secret: secretSessionWith(), pii: null }),
			rawSecrets: [VALID_CARD],
			rawPii: [],
			equivalence: true,
		},
		{
			name: "spaced SSN detected in prose",
			text: `Their SSN ${VALID_SSN} is on the intake form.`,
			factory: async () => ({ secret: secretSessionWith(), pii: null }),
			rawSecrets: [VALID_SSN],
			rawPii: [],
			equivalence: true,
		},
		{
			name: "spaced IBAN detected in prose",
			text: `Wire the retainer to ${VALID_IBAN} by end of week.`,
			factory: async () => ({ secret: secretSessionWith(), pii: null }),
			rawSecrets: [VALID_IBAN],
			rawPii: [],
			equivalence: true,
		},
		{
			name: "valid BIP39 mnemonic detected in prose",
			text: `My recovery phrase is ${VALID_MNEMONIC} please store it.`,
			factory: async () => ({ secret: secretSessionWith(), pii: null }),
			rawSecrets: [VALID_MNEMONIC],
			rawPii: [],
			equivalence: true,
		},
		{
			name: "KEY= assignment detected in prose",
			text: "Set API_KEY=abc123def456ghi789jkl in the environment.",
			factory: async () => ({ secret: secretSessionWith(), pii: null }),
			rawSecrets: ["abc123def456ghi789jkl"],
			rawPii: [],
			equivalence: true,
		},
		{
			name: "JSON password field with a spaced value",
			text: 'Payload {"password": "hunter2 spaced pass"} was sent.',
			factory: async () => ({ secret: secretSessionWith(), pii: null }),
			rawSecrets: ["hunter2 spaced pass"],
			rawPii: [],
			equivalence: true,
		},
		{
			name: "opaque Authorization Bearer header",
			text: "Header Authorization: Bearer abcdefghij1234567890KLMNOPqrst now.",
			factory: async () => ({ secret: secretSessionWith(), pii: null }),
			rawSecrets: ["abcdefghij1234567890KLMNOPqrst"],
			rawPii: [],
			equivalence: true,
		},
		{
			name: "streamed full PEM block detected (not pre-known)",
			text: `Here:\n${PEM_KEY}\ndone.`,
			factory: async () => ({ secret: secretSessionWith(), pii: null }),
			rawSecrets: [
				"MIIBVAIBADANBgkqhkiG9w0BAQEFAASCAT4w",
				"ggE6AgEAAkEAqwArU3",
			],
			rawPii: [],
			equivalence: true,
		},
		{
			name: "multiple pre-seeded known secrets (fixed numbering)",
			text: "Use sk-live-Abc123Def456Ghi789 with token ghp_ABCDEFGHIJ1234567890abcd here.",
			factory: async () => ({
				secret: secretSessionWith({
					OPENAI: "sk-live-Abc123Def456Ghi789",
					GITHUB: "ghp_ABCDEFGHIJ1234567890abcd",
				}),
				pii: null,
			}),
			rawSecrets: [
				"sk-live-Abc123Def456Ghi789",
				"ghp_ABCDEFGHIJ1234567890abcd",
			],
			rawPii: [],
			equivalence: true,
		},
		{
			name: "secret + PII composed",
			text: `Send the invoice for ${surrogate} using key sk-live-Abc123Def456Ghi789 today.`,
			factory: async () => ({
				secret: secretSessionWith({ INVOICE: "sk-live-Abc123Def456Ghi789" }),
				pii: await piiSessionLearning([
					{ kind: "person", value: "Dana Whitfield" },
				]),
			}),
			rawSecrets: ["sk-live-Abc123Def456Ghi789"],
			rawPii: ["Dana Whitfield"],
			equivalence: true,
		},
		{
			name: "HTTP Basic auth header (anchor split from scheme+value)",
			text: `Header Authorization: Basic ${BASIC_B64} end of line.`,
			factory: async () => ({ secret: secretSessionWith(), pii: null }),
			rawSecrets: [BASIC_B64],
			rawPii: [],
			equivalence: true,
		},
		{
			name: "long HTTP Basic auth header (anchor more than opener window behind value)",
			text: `Header Authorization: Basic ${LONG_BASIC_B64} end of line.`,
			factory: async () => ({ secret: secretSessionWith(), pii: null }),
			rawSecrets: [LONG_BASIC_B64],
			rawPii: [],
			equivalence: true,
			chunkings: (text) =>
				targetedLongChunkings(text, [
					"Authorization:",
					"Basic ",
					LONG_BASIC_B64,
				]),
		},
		{
			name: "long opaque Authorization Bearer header",
			text: `Header Authorization: Bearer ${LONG_ANCHORED_VALUE} end of line.`,
			factory: async () => ({ secret: secretSessionWith(), pii: null }),
			rawSecrets: [LONG_ANCHORED_VALUE],
			rawPii: [],
			equivalence: true,
			chunkings: (text) =>
				targetedLongChunkings(text, [
					"Authorization:",
					"Bearer ",
					LONG_ANCHORED_VALUE,
				]),
		},
		{
			name: "long ENV colon assignment with separated value",
			text: `Set LONG_SECRET: ${LONG_ANCHORED_VALUE} before deploy.`,
			factory: async () => ({ secret: secretSessionWith(), pii: null }),
			rawSecrets: [LONG_ANCHORED_VALUE],
			rawPii: [],
			equivalence: true,
			chunkings: (text) =>
				targetedLongChunkings(text, ["LONG_SECRET:", LONG_ANCHORED_VALUE]),
		},
		{
			name: "long JSON password field",
			text: `Payload {"password": "${LONG_ANCHORED_VALUE}"} was sent.`,
			factory: async () => ({ secret: secretSessionWith(), pii: null }),
			rawSecrets: [LONG_ANCHORED_VALUE],
			rawPii: [],
			equivalence: true,
			chunkings: (text) =>
				targetedLongChunkings(text, ['"password":', LONG_ANCHORED_VALUE]),
		},
		{
			name: "long CLI password flag with separated value",
			text: `Run deploy --password ${LONG_ANCHORED_VALUE} after rotation.`,
			factory: async () => ({ secret: secretSessionWith(), pii: null }),
			rawSecrets: [LONG_ANCHORED_VALUE],
			rawPii: [],
			equivalence: true,
			chunkings: (text) =>
				targetedLongChunkings(text, ["--password", LONG_ANCHORED_VALUE]),
		},
		...PHONE_FORMS.map((phone) => ({
			name: `NANP phone (${phone})`,
			text: `Please call ${phone} tomorrow morning.`,
			factory: async () => ({ secret: secretSessionWith(), pii: null }),
			rawSecrets: [phone],
			rawPii: [],
			equivalence: true,
		})),
		{
			name: "credit card, dash-separated groups",
			text: "Charge 4111-1111-1111-1111 today please.",
			factory: async () => ({ secret: secretSessionWith(), pii: null }),
			rawSecrets: ["4111-1111-1111-1111"],
			rawPii: [],
			equivalence: true,
		},
		{
			name: "SSN, dash-separated",
			text: "SSN 123-45-6789 on file.",
			factory: async () => ({ secret: secretSessionWith(), pii: null }),
			rawSecrets: ["123-45-6789"],
			rawPii: [],
			equivalence: true,
		},
		// One instance of every remaining detector kind, each a whitespace-free
		// single token (so snapToWhitespace holds it) — proves the streamed pipeline
		// redacts the full class registry, not just the whitespace-spanning shapes.
		...(
			[
				["email", "dana.whitfield@example.com"],
				["ipv4", "192.168.1.100"],
				["mac-address", "3D:F2:C9:A6:B3:4F"],
				["jwt", JWT_TOKEN],
				["url-credentials", URL_CREDENTIALS],
				["slack-webhook-url", SLACK_WEBHOOK_URL],
				["anthropic-key", "sk-ant-api03-ABCDEFGHIJ1234567890abcd"],
				["stripe-webhook-secret", "whsec_ABCDEFGHIJ1234567890abcd"],
				["aws-access-key", "AKIAABCDEFGH12345678"],
				["github-token", "ghp_ABCDEFGHIJ1234567890abcdefghij123456"],
				["openai-key", "sk-ABCDEFGHIJ1234567890abcd"],
				["slack-token", "xoxb-123456789012-abcdefghij"],
				["telegram-bot-token", "1234567890:AAABCDEFGHIJ1234567890abcdefghij12"],
				["google-api-key", "AIzaABCDEFGHIJ1234567890abcdefghij12345"],
				["google-oauth-refresh-token", "1//0ABCDEFGHIJ1234567890abcd"],
				["wif-private-key", WIF_KEY],
				["hex-secret", `0x${"a".repeat(64)}`],
			] as const
		).map(([kind, value]) => ({
			name: `single-token secret (${kind})`,
			text: `The ${kind} value is ${value} in the config.`,
			factory: async () => ({ secret: secretSessionWith(), pii: null }),
			rawSecrets: [value],
			rawPii: [],
			equivalence: true,
		})),
	];
}

describe("GuardedStreamScanner", () => {
	it("streams equivalently to whole-buffer output at every split, never leaking a raw value", async () => {
		const fixtures = await buildFixtures();
		for (const fx of fixtures) {
			const ref = await fx.factory();
			const reference = buffered(fx.text, ref.secret, ref.pii);
			const refSafe = normalize(reference.safe);
			const refVisible = normalize(reference.visible);

			// The whole-buffer reference itself must be clean (sanity on the fixture).
			for (const raw of [...fx.rawSecrets, ...fx.rawPii]) {
				expect(
					reference.safe,
					`${fx.name}: ref.safe leaks ${raw}`,
				).not.toContain(raw);
			}

			for (const chunks of (fx.chunkings ?? chunkings)(fx.text)) {
				const { secret, pii } = await fx.factory();
				const scanner = new GuardedStreamScanner({
					secretSession: secret,
					piiSession: pii,
				});
				const { increments, safe, visible } = run(scanner, chunks);

				// No emitted increment (a single SSE chunk) may contain a raw value.
				for (const inc of increments) {
					for (const raw of [...fx.rawSecrets, ...fx.rawPii]) {
						expect(
							inc.safe,
							`${fx.name}: increment safe leaks ${raw}`,
						).not.toContain(raw);
					}
					for (const raw of fx.rawSecrets) {
						expect(
							inc.visible,
							`${fx.name}: increment visible leaks secret ${raw}`,
						).not.toContain(raw);
					}
				}

				// The reassembled reply is clean too, and PII is restored on the visible side.
				for (const raw of [...fx.rawSecrets, ...fx.rawPii]) {
					expect(safe, `${fx.name}: safe concat leaks ${raw}`).not.toContain(
						raw,
					);
				}
				for (const raw of fx.rawSecrets) {
					expect(
						visible,
						`${fx.name}: visible concat leaks secret ${raw}`,
					).not.toContain(raw);
				}
				for (const raw of fx.rawPii) {
					expect(
						visible,
						`${fx.name}: visible concat dropped restored PII ${raw}`,
					).toContain(raw);
				}

				if (fx.equivalence) {
					expect(
						normalize(safe),
						`${fx.name}: safe not equivalent for ${JSON.stringify(chunks)}`,
					).toBe(refSafe);
					expect(
						normalize(visible),
						`${fx.name}: visible not equivalent for ${JSON.stringify(chunks)}`,
					).toBe(refVisible);
				}
			}
		}
	});

	it("restores time-to-first-token: emits multiple increments before flush on plain prose", async () => {
		const secret = secretSessionWith({ KEY: "sk-live-Abc123Def456Ghi789" });
		const scanner = new GuardedStreamScanner({
			secretSession: secret,
			piiSession: null,
		});
		const sentences = [
			"The quarterly review went well and the team is optimistic. ",
			"We shipped four features and closed the top support tickets. ",
			"Marketing wants a recap deck by Thursday afternoon at the latest. ",
			"Everyone agreed to sync again on Monday to plan the next sprint. ",
		];
		const emitted: string[] = [];
		let nonEmptyPushes = 0;
		for (const s of sentences) {
			const out = scanner.push(s);
			emitted.push(out.safe);
			if (out.safe.length > 0) nonEmptyPushes += 1;
		}
		emitted.push(scanner.flush().safe);
		// Genuinely incremental: output arrives across multiple pushes, not one block.
		expect(nonEmptyPushes).toBeGreaterThanOrEqual(3);
		// The reassembled reply is byte-identical to the input (no secret present).
		expect(emitted.join("")).toBe(sentences.join(""));
	});

	it("holds an entire PEM block until its END marker, never emitting armor-body bytes", async () => {
		const scanner = new GuardedStreamScanner({
			secretSession: secretSessionWith(),
			piiSession: null,
		});
		const lines = [
			"Here is the key:\n",
			"-----BEGIN PRIVATE KEY-----\n",
			"MIIBVAIBADANBgkqhkiG9w0BAQEFAASCAT4w\n",
			"ggE6AgEAAkEAqwArU3\n",
			"-----END PRIVATE KEY-----\n",
			"All done.",
		];
		const bodyBytes = [
			"MIIBVAIBADANBgkqhkiG9w0BAQEFAASCAT4w",
			"ggE6AgEAAkEAqwArU3",
		];
		let emittedBeforeEnd = "";
		for (const line of lines) {
			if (line.startsWith("-----END")) break;
			emittedBeforeEnd += scanner.push(line).safe;
		}
		for (const body of bodyBytes) {
			expect(emittedBeforeEnd).not.toContain(body);
		}
		// Push the END line and flush; the whole block collapses to one placeholder.
		const endOut = scanner.push("-----END PRIVATE KEY-----\n");
		const tail = scanner.push("All done.");
		const flushed = scanner.flush();
		const total = emittedBeforeEnd + endOut.safe + tail.safe + flushed.safe;
		for (const body of bodyBytes) {
			expect(total).not.toContain(body);
		}
		expect(total).toMatch(/__ELIZA_SECRET_[0-9a-f]+_\d+__/);
		expect(total).toContain("Here is the key:");
		expect(total).toContain("All done.");
	});

	it("streams ordinary short-word prose promptly (BIP39 run rule does not wedge)", async () => {
		const scanner = new GuardedStreamScanner({
			secretSession: secretSessionWith(),
			piiSession: null,
		});
		const prose =
			"the cat sat on the warm mat and the happy dog ran across the green yard quickly toward home ";
		const out = scanner.push(prose);
		// Most of the prose clears immediately; only a small trailing window is held.
		expect(out.safe.length).toBeGreaterThan(prose.length / 2);
		const tail = scanner.flush();
		expect(out.safe + tail.safe).toBe(prose);
	});

	it("protects a repeated secret learned mid-stream (session grows, scanner reads it live)", async () => {
		const key = "sk-live-Abc123Def456Ghi789";
		const text = `first ${key} then filler words here and again ${key} end`;
		const scanner = new GuardedStreamScanner({
			secretSession: secretSessionWith(),
			piiSession: null,
		});
		// Chunk so the first occurrence is fully learned before the second arrives.
		const cutAt = text.indexOf("again");
		const parts = [text.slice(0, cutAt), text.slice(cutAt)];
		const { safe } = run(scanner, parts);
		expect(safe).not.toContain(key);
		// Both occurrences map to the SAME placeholder (session is consistent).
		const placeholders = safe.match(/__ELIZA_SECRET_[0-9a-f]+_\d+__/g) ?? [];
		expect(placeholders).toHaveLength(2);
		expect(new Set(placeholders).size).toBe(1);
	});

	it("swaps and restores a PII entity learned between pushes", async () => {
		const session = await piiSessionLearning([
			{ kind: "person", value: "Dana Whitfield" },
		]);
		const scanner = new GuardedStreamScanner({
			secretSession: null,
			piiSession: session,
		});
		const parts: GuardedStreamOutput[] = [];
		parts.push(
			scanner.push("Draft a short note for the team about scheduling. "),
		);
		// A new entity is introduced into the turn-shared session mid-stream; the
		// scanner reads session state live, so it must pick the new surrogate up.
		session.learnSpans("Marcus Bell", [
			{ kind: "person", value: "Marcus Bell", start: 0, end: 11 },
		]);
		const marcusSurrogate = session.entries.find(
			(e) => e.value === "Marcus Bell",
		)?.surrogate as string;
		expect(marcusSurrogate).toBeTruthy();
		parts.push(
			scanner.push(`Then loop in ${marcusSurrogate} on the thread later.`),
		);
		parts.push(scanner.flush());
		const safe = parts.map((p) => p.safe).join("");
		const visible = parts.map((p) => p.visible).join("");
		// The new entity's surrogate stays on the safe side and restores on the visible side.
		expect(safe).not.toContain("Marcus Bell");
		expect(safe).toContain(marcusSurrogate);
		expect(visible).toContain("Marcus Bell");
		expect(visible).not.toContain(marcusSurrogate);
	});
});

// Seeded, reproducible property fuzz mirroring secret-swap.fuzz.test.ts: a single
// planted secret in random benign filler, chunked randomly, must reassemble to the
// whole-buffer output with zero leakage.
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

const FILLER_WORDS = [
	"the",
	"report",
	"is",
	"ready",
	"and",
	"we",
	"should",
	"review",
	"it",
	"before",
	"the",
	"meeting",
	"tomorrow",
	"afternoon",
	"with",
	"everyone",
];

const PLANTED = [
	"sk-live-Abc123Def456Ghi789",
	"ghp_ABCDEFGHIJ1234567890abcdefghij1234",
	VALID_CARD,
	VALID_IBAN,
	VALID_MNEMONIC,
	"API_TOKEN=zzz111yyy222xxx333www",
];

describe("GuardedStreamScanner fuzz", () => {
	it("reassembles to whole-buffer output over random chunkings (200 seeds)", () => {
		for (let seed = 1; seed <= 200; seed += 1) {
			const rng = mulberry32(seed);
			const planted = PLANTED[Math.floor(rng() * PLANTED.length)] as string;
			const rawValue = planted.includes("=")
				? (planted.split("=")[1] as string)
				: planted;

			const before: string[] = [];
			const after: string[] = [];
			const beforeCount = 1 + Math.floor(rng() * 6);
			const afterCount = 1 + Math.floor(rng() * 6);
			for (let i = 0; i < beforeCount; i += 1)
				before.push(
					FILLER_WORDS[Math.floor(rng() * FILLER_WORDS.length)] as string,
				);
			for (let i = 0; i < afterCount; i += 1)
				after.push(
					FILLER_WORDS[Math.floor(rng() * FILLER_WORDS.length)] as string,
				);
			const text = `${before.join(" ")} ${planted} ${after.join(" ")}`;

			const reference = normalize(
				buffered(text, secretSessionWith(), null).safe,
			);

			// Random chunking.
			const chunks: string[] = [];
			let i = 0;
			while (i < text.length) {
				const len = 1 + Math.floor(rng() * 9);
				chunks.push(text.slice(i, i + len));
				i += len;
			}
			const scanner = new GuardedStreamScanner({
				secretSession: secretSessionWith(),
				piiSession: null,
			});
			const { safe, increments } = run(scanner, chunks);
			expect(normalize(safe), `seed ${seed} not equivalent`).toBe(reference);
			expect(safe, `seed ${seed} leaks ${rawValue}`).not.toContain(rawValue);
			for (const inc of increments) {
				expect(inc.safe, `seed ${seed} increment leaks`).not.toContain(
					rawValue,
				);
			}
		}
	});
});

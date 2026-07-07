/**
 * End-to-end proof that the streaming secret/PII guard (#15256) delivers a
 * guarded reply incrementally through the real `AgentRuntime.useModel` path
 * rather than buffering the whole stream and flushing one terminal chunk.
 *
 * Deterministic (fixed salt, no live model): a registered streaming model
 * handler yields many small chunks — with a raw secret and an echoed PII
 * surrogate deliberately split across yield boundaries — and the test asserts
 * `onStreamChunk` fires repeatedly (TTFT restored), the joined safe/visible text
 * matches the pre-#15256 whole-buffer pipeline, no chunk ever carries the raw
 * secret, and an abort mid-stream drops the held tail instead of emitting it.
 */
import { describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "../../database/inMemoryAdapter";
import { AgentRuntime } from "../../runtime";
import {
	GazetteerEntityRecognizer,
	PseudonymSession,
	SecretSwapSession,
} from "../../security/index.js";
import { runWithStreamingContext } from "../../streaming-context";
import { runWithTrajectoryContext } from "../../trajectory-context";
import { type Character, ModelType } from "../../types";

const SALT = "fixed-guarded-stream-use-model-salt";
const SECRET = "sk-live-Str3amGuardKey1234567890";
const NAME = "Dana Whitfield";

function makeRuntime(): AgentRuntime {
	return new AgentRuntime({
		character: {
			name: "GuardedStreamAgent",
			bio: "test",
			secrets: { DEPLOY_KEY: SECRET },
			settings: {
				ELIZA_SECRET_SWAP_ENABLED: true,
				ELIZA_PII_SWAP_ENABLED: true,
			},
		} as Character,
		adapter: new InMemoryDatabaseAdapter(),
		logLevel: "fatal",
	});
}

/** Fresh, identically-seeded turn sessions — the reply echoes a surrogate, so the
 * PII session must already know the name↔surrogate mapping before the stream. */
async function freshSessions(): Promise<{
	secret: SecretSwapSession;
	pii: PseudonymSession;
}> {
	const secret = new SecretSwapSession({
		knownSecrets: { DEPLOY_KEY: SECRET },
	});
	const pii = new PseudonymSession({
		salt: SALT,
		recognizer: new GazetteerEntityRecognizer([
			{ kind: "person", value: NAME },
		]),
	});
	await pii.learn(NAME);
	return { secret, pii };
}

/** The exact pipeline the pre-#15256 `flushGuardedStream` ran over the whole buffer. */
function buffered(
	text: string,
	secret: SecretSwapSession,
	pii: PseudonymSession,
): { safe: string; visible: string } {
	const safe = pii.substituteText(secret.substituteText(text));
	return { safe, visible: pii.restoreText(safe) };
}

/** Erase the random per-session secret nonce so placeholder NUMBERING is compared. */
function normalize(text: string): string {
	return text.replace(/__ELIZA_SECRET_[0-9a-f]+_(\d+)__/g, "__S$1__");
}

describe("AgentRuntime.useModel streaming guard — incremental egress (#15256)", () => {
	it("streams a guarded reply in multiple chunks, equivalent to whole-buffer output, never leaking the raw secret", async () => {
		const runtime = makeRuntime();
		const seeded = await freshSessions();
		const surrogate = seeded.pii.entries[0]?.surrogate as string;
		expect(surrogate).toBeTruthy();

		// The model echoes the swapped-prompt surrogate for the name and emits a raw
		// secret it "generated". Both are split across yield boundaries so the guard
		// must reassemble across chunks before it can safely emit either.
		const reply =
			`Sure, I drafted the note for ${surrogate.slice(0, 4)}${surrogate.slice(4)} and ` +
			`saved it. The deploy key is ${SECRET.slice(0, 10)}${SECRET.slice(10)} which ` +
			`the pipeline reads at boot. Let me know if you want any edits before I send it.`;
		const yields = splitEvery(reply, 5);

		const reference = buffered(reply, seeded.secret, seeded.pii);
		expect(reference.safe).not.toContain(SECRET);
		expect(reference.safe).not.toContain(NAME);
		expect(reference.visible).toContain(NAME);

		const visibleChunks: string[] = [];
		const runSession = await freshSessions();
		runtime.registerModel(
			ModelType.TEXT_SMALL,
			async () => ({
				text: Promise.resolve("streamed"),
				textStream: iterate(yields),
				usage: Promise.resolve({}),
				finishReason: Promise.resolve("stop"),
			}),
			"test",
		);

		const result = await runWithTrajectoryContext(
			{
				runId: "run-guarded-stream",
				secretSwapSession: runSession.secret,
				piiSwapSession: runSession.pii,
			},
			() =>
				runWithStreamingContext(
					{
						onStreamChunk: (chunk: string) => {
							visibleChunks.push(chunk);
						},
					},
					() =>
						runtime.useModel(ModelType.TEXT_SMALL, {
							prompt: "Continue the update.",
							stream: true,
						}),
				),
		);

		// TTFT restored: the guarded reply arrived across many chunks, not one block.
		expect(visibleChunks.length).toBeGreaterThanOrEqual(3);

		// No single emitted chunk (an SSE frame) ever carries the raw secret.
		for (const chunk of visibleChunks) {
			expect(chunk).not.toContain(SECRET);
		}

		// Visible side restores the real name; the raw secret is masked everywhere.
		const visible = visibleChunks.join("");
		expect(visible).not.toContain(SECRET);
		expect(visible).toContain(NAME);
		expect(normalize(visible)).toBe(normalize(reference.visible));

		// The returned (safe) result keeps the surrogate + placeholder — real values
		// never re-enter logs — and equals the whole-buffer safe output.
		const safe = String(result);
		expect(safe).not.toContain(SECRET);
		expect(safe).not.toContain(NAME);
		expect(safe).toContain(surrogate);
		expect(safe).toMatch(/__ELIZA_SECRET_[0-9a-f]+_\d+__/);
		expect(normalize(safe)).toBe(normalize(reference.safe));
	});

	it("drops the held tail on abort mid-stream — a partially-arrived secret is never emitted", async () => {
		const runtime = makeRuntime();
		const runSession = await freshSessions();
		const controller = new AbortController();
		const visibleChunks: string[] = [];

		// Yield prose long enough that its lead clears past the carry-over window,
		// then the FIRST half of the secret (held back as an in-progress token), then
		// abort before the rest arrives. The held fragment must be dropped by the
		// aborted flush, never emitted.
		const intro =
			"Here is the deploy key that the pipeline reads at boot, kept offline and rotated monthly, value ";
		const firstHalf = SECRET.slice(0, 12);
		async function* stream() {
			yield intro;
			yield firstHalf;
			controller.abort();
			yield `${SECRET.slice(12)} for the pipeline.`;
		}

		runtime.registerModel(
			ModelType.TEXT_SMALL,
			async () => ({
				text: Promise.resolve("streamed"),
				textStream: stream(),
				usage: Promise.resolve({}),
				finishReason: Promise.resolve("stop"),
			}),
			"test",
		);

		const result = await runWithTrajectoryContext(
			{
				runId: "run-guarded-abort",
				secretSwapSession: runSession.secret,
				piiSwapSession: runSession.pii,
			},
			() =>
				runWithStreamingContext(
					{
						abortSignal: controller.signal,
						onStreamChunk: (chunk: string) => {
							visibleChunks.push(chunk);
						},
					},
					() =>
						runtime.useModel(ModelType.TEXT_SMALL, {
							prompt: "Continue the update.",
							stream: true,
						}),
				),
		);

		// The intro prose cleared, but neither the full secret nor its held first
		// half ever crossed the wire.
		const visible = visibleChunks.join("");
		expect(visible).toContain("Here is the deploy key");
		expect(visible).not.toContain(SECRET);
		expect(visible).not.toContain(firstHalf);
		// The returned (safe) result is the pre-abort prefix only, still secret-free.
		expect(String(result)).not.toContain(SECRET);
		expect(String(result)).not.toContain(firstHalf);
	});

	it("is a no-op passthrough when both guards are disabled (single, unmodified stream)", async () => {
		const runtime = new AgentRuntime({
			character: {
				name: "UnguardedStreamAgent",
				bio: "test",
				settings: {
					ELIZA_SECRET_SWAP_ENABLED: false,
					ELIZA_PII_SWAP_ENABLED: false,
				},
			} as Character,
			adapter: new InMemoryDatabaseAdapter(),
			logLevel: "fatal",
		});
		const reply = "The quick brown fox jumps over the lazy dog every morning.";
		const visibleChunks: string[] = [];
		runtime.registerModel(
			ModelType.TEXT_SMALL,
			async () => ({
				text: Promise.resolve("streamed"),
				textStream: iterate(splitEvery(reply, 7)),
				usage: Promise.resolve({}),
				finishReason: Promise.resolve("stop"),
			}),
			"test",
		);

		const result = await runWithStreamingContext(
			{
				onStreamChunk: (chunk: string) => {
					visibleChunks.push(chunk);
				},
			},
			() =>
				runtime.useModel(ModelType.TEXT_SMALL, {
					prompt: "Continue.",
					stream: true,
				}),
		);

		// Disabled guard: every raw chunk passes straight through, unbuffered.
		expect(visibleChunks.length).toBeGreaterThanOrEqual(3);
		expect(visibleChunks.join("")).toBe(reply);
		expect(String(result)).toBe(reply);
	});
});

/** Split `text` into fixed-size pieces (last piece may be shorter). */
function splitEvery(text: string, size: number): string[] {
	const parts: string[] = [];
	for (let i = 0; i < text.length; i += size)
		parts.push(text.slice(i, i + size));
	return parts;
}

async function* iterate(chunks: readonly string[]): AsyncGenerator<string> {
	for (const chunk of chunks) yield chunk;
}

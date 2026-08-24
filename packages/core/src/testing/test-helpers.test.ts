/**
 * Unit tests for core test helpers: validates the id/memory/character
 * factories, waitFor timeout behaviour, expectRejection matching rules,
 * retry backoff accounting, measureTime reporting, and the shape of the
 * values produced by testDataGenerators.
 */
import { describe, expect, it } from "vitest";
import {
	createTestCharacter,
	createTestMemory,
	expectRejection,
	generateTestId,
	measureTime,
	retry,
	testDataGenerators,
	waitFor,
} from "./test-helpers.ts";

const UUID_V4_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("test-helpers", () => {
	describe("generateTestId", () => {
		it("produces unique v4-formatted UUIDs", () => {
			const first = generateTestId();
			const second = generateTestId();
			expect(first).toMatch(UUID_V4_PATTERN);
			expect(second).toMatch(UUID_V4_PATTERN);
			expect(first).not.toBe(second);
		});
	});

	describe("createTestMemory", () => {
		it("wraps string content into a text content object", () => {
			const memory = createTestMemory({ content: "hello world" });
			expect(memory.content).toEqual({ text: "hello world" });
		});

		it("passes structured content through by reference", () => {
			const content = { text: "structured" };
			const memory = createTestMemory({ content });
			expect(memory.content).toBe(content);
		});

		it("honours explicit entity, room, and agent ids", () => {
			const entityId = generateTestId();
			const roomId = generateTestId();
			const agentId = generateTestId();
			const memory = createTestMemory({
				entityId,
				roomId,
				agentId,
				content: "explicit",
			});
			expect(memory.entityId).toBe(entityId);
			expect(memory.roomId).toBe(roomId);
			expect(memory.agentId).toBe(agentId);
		});

		it("generates distinct entity and room ids when omitted", () => {
			const first = createTestMemory({ content: "one" });
			const second = createTestMemory({ content: "two" });
			expect(first.entityId).toMatch(UUID_V4_PATTERN);
			expect(first.roomId).toMatch(UUID_V4_PATTERN);
			expect(first.entityId).not.toBe(second.entityId);
			expect(first.roomId).not.toBe(first.entityId);
		});

		it("leaves agentId unset when omitted and stamps createdAt near now", () => {
			const before = Date.now();
			const memory = createTestMemory({ content: "timestamped" });
			expect(memory.agentId).toBeUndefined();
			expect(memory.createdAt).toBeGreaterThanOrEqual(before);
			expect(memory.createdAt).toBeLessThanOrEqual(Date.now());
		});
	});

	describe("createTestCharacter", () => {
		it("supplies the documented defaults when called bare", () => {
			const character = createTestCharacter();
			expect(character.name).toBe("TestAgent");
			expect(character.system).toBe("You are a test agent.");
			expect(character.bio).toEqual(["Test agent"]);
			expect(character.topics).toEqual(["testing"]);
			expect(character.templates).toEqual({});
			expect(character.plugins).toEqual([]);
		});

		it("lets overrides win over every defaulted field", () => {
			const character = createTestCharacter({
				name: "Named",
				topics: ["override"],
				settings: { theme: "dark" },
			});
			expect(character.name).toBe("Named");
			expect(character.topics).toEqual(["override"]);
			expect(character.settings).toEqual({ theme: "dark" });
		});

		it("preserves falsy-but-defined overrides instead of re-defaulting", () => {
			const character = createTestCharacter({ name: "" });
			expect(character.name).toBe("");
		});

		it("returns fresh mutable containers on each call", () => {
			const first = createTestCharacter();
			const second = createTestCharacter();
			expect(first.templates).not.toBe(second.templates);
			expect(first.bio).not.toBe(second.bio);
			first.bio.push("mutated");
			expect(createTestCharacter().bio).toEqual(["Test agent"]);
		});
	});

	describe("waitFor", () => {
		it("resolves immediately without waiting when the condition starts true", async () => {
			const start = Date.now();
			await waitFor(() => true, { timeout: 10_000, interval: 5 });
			expect(Date.now() - start).toBeLessThan(1_000);
		});

		it("keeps polling until an initially false condition turns true", async () => {
			let calls = 0;
			await waitFor(
				() => {
					calls += 1;
					return calls >= 3;
				},
				{ timeout: 2_000, interval: 10 },
			);
			expect(calls).toBe(3);
		});

		it("supports asynchronous conditions", async () => {
			let calls = 0;
			await waitFor(
				async () => {
					calls += 1;
					return calls >= 2;
				},
				{ timeout: 2_000, interval: 10 },
			);
			expect(calls).toBe(2);
		});

		it("rejects with the timeout duration in the message when never satisfied", async () => {
			await expect(
				waitFor(() => false, { timeout: 60, interval: 10 }),
			).rejects.toThrow("Condition not met within 60ms timeout");
		});
	});

	describe("expectRejection", () => {
		it("returns the original error when the message includes the expected substring", async () => {
			const error = await expectRejection(
				Promise.reject(new Error("boom: detail")),
				"boom",
			);
			expect(error).toBeInstanceOf(Error);
			expect(error.message).toBe("boom: detail");
		});

		it("matches regular expressions against the message", async () => {
			const error = await expectRejection(
				Promise.reject(new Error("code 42 failed")),
				/code \d+ failed/,
			);
			expect(error.message).toBe("code 42 failed");
		});

		it("throws a descriptive mismatch when a string expectation fails", async () => {
			await expect(
				expectRejection(
					Promise.reject(new Error("actual")),
					"expected-substring",
				),
			).rejects.toThrow(
				'Expected error message to include "expected-substring"',
			);
		});

		it("throws a descriptive mismatch when a regexp expectation fails", async () => {
			await expect(
				expectRejection(Promise.reject(new Error("actual")), /^nope/),
			).rejects.toThrow("Expected error message to match /^nope/");
		});

		it("throws when the promise resolves instead of rejecting", async () => {
			await expect(expectRejection(Promise.resolve("fine"))).rejects.toThrow(
				"Expected promise to reject but it resolved",
			);
		});

		it("reports the typeof value when the rejection is not an Error", async () => {
			await expect(
				expectRejection(Promise.reject("plain-string")),
			).rejects.toThrow("Expected Error but got: string");
		});

		it("rethrows a rejection whose message equals the internal sentinel", async () => {
			await expect(
				expectRejection(
					Promise.reject(
						new Error("Expected promise to reject but it resolved"),
					),
				),
			).rejects.toThrow("Expected promise to reject but it resolved");
		});
	});

	describe("retry", () => {
		it("returns on the first success without extra calls", async () => {
			let calls = 0;
			const result = await retry(async () => {
				calls += 1;
				return "value";
			});
			expect(result).toBe("value");
			expect(calls).toBe(1);
		});

		it("retries failures until the fn succeeds", async () => {
			let calls = 0;
			const result = await retry(
				async () => {
					calls += 1;
					if (calls < 3) {
						throw new Error(`attempt ${calls} failed`);
					}
					return "recovered";
				},
				{ maxRetries: 3, baseDelay: 5 },
			);
			expect(result).toBe("recovered");
			expect(calls).toBe(3);
		});

		it("exhausts maxRetries and throws the last error", async () => {
			let calls = 0;
			const outcome = retry(
				async () => {
					calls += 1;
					throw new Error(`always fails ${calls}`);
				},
				{ maxRetries: 2, baseDelay: 1 },
			);
			await expect(outcome).rejects.toThrow("always fails 3");
			expect(calls).toBe(3);
		});

		it("wraps non-Error rejections into Errors carrying String(value)", async () => {
			let calls = 0;
			const outcome = retry(
				async () => {
					calls += 1;
					return Promise.reject("raw-rejection");
				},
				{ maxRetries: 1, baseDelay: 1 },
			);
			await expect(outcome).rejects.toBeInstanceOf(Error);
			await expect(outcome).rejects.toThrow("raw-rejection");
			expect(calls).toBe(2);
		});

		it("waits the exponential backoff between failed attempts", async () => {
			const start = Date.now();
			const outcome = retry(
				async () => {
					throw new Error("backoff probe");
				},
				{ maxRetries: 2, baseDelay: 20 },
			);
			await expect(outcome).rejects.toThrow("backoff probe");
			const elapsed = Date.now() - start;
			expect(elapsed).toBeGreaterThanOrEqual(55);
		});
	});

	describe("measureTime", () => {
		it("returns the wrapped result and a non-negative duration", async () => {
			const { result, durationMs } = await measureTime(async () => 42);
			expect(result).toBe(42);
			expect(durationMs).toBeGreaterThanOrEqual(0);
		});

		it("reports durations that reflect the awaited work", async () => {
			const { result, durationMs } = await measureTime(
				async () =>
					new Promise<string>((resolve) =>
						setTimeout(() => resolve("late"), 20),
					),
			);
			expect(result).toBe("late");
			expect(durationMs).toBeGreaterThanOrEqual(15);
		});
	});

	describe("testDataGenerators", () => {
		it("uuid yields unique v4 UUIDs", () => {
			const first = testDataGenerators.uuid();
			const second = testDataGenerators.uuid();
			expect(first).toMatch(UUID_V4_PATTERN);
			expect(second).toMatch(UUID_V4_PATTERN);
			expect(first).not.toBe(second);
		});

		it("randomString honours length and stays alphanumeric", () => {
			expect(testDataGenerators.randomString()).toHaveLength(10);
			const generated = testDataGenerators.randomString(32);
			expect(generated).toHaveLength(32);
			expect(generated).toMatch(/^[A-Za-z0-9]+$/);
		});

		it("randomSentence joins five to fourteen known words with spaces", () => {
			const allowedWords = new Set([
				"hello",
				"world",
				"test",
				"agent",
				"memory",
				"runtime",
				"integration",
			]);
			for (let i = 0; i < 25; i++) {
				const sentence = testDataGenerators.randomSentence();
				const words = sentence.split(" ");
				expect(words.length).toBeGreaterThanOrEqual(5);
				expect(words.length).toBeLessThanOrEqual(14);
				for (const word of words) {
					expect(allowedWords.has(word)).toBe(true);
				}
			}
		});
	});
});

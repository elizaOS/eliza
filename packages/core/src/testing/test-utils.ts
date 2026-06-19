/**
 * Test utilities for the core package.
 */

import type { Character, Content, Memory, UUID } from "../types";

/**
 * Create a test memory with sensible defaults.
 * Accepts a string for `content` (auto-wrapped to `{ text }`) or a Content object.
 */
export function createTestMemory(
	overrides: Partial<Omit<Memory, "content">> & {
		content?: string | Content;
	} = {},
): Memory {
	const { content, ...rest } = overrides;
	const resolvedContent: Content =
		typeof content === "string"
			? { text: content }
			: (content ?? { text: "test memory" });

	return {
		id: crypto.randomUUID() as UUID,
		entityId: crypto.randomUUID() as UUID,
		agentId: crypto.randomUUID() as UUID,
		roomId: crypto.randomUUID() as UUID,
		content: resolvedContent,
		createdAt: Date.now(),
		...rest,
	} as Memory;
}

/**
 * Create a test character with sensible defaults.
 */
export function createTestCharacter(
	overrides: Partial<Character> = {},
): Character {
	return {
		name: "TestAgent",
		system: "You are a test agent.",
		bio: ["Test agent"],
		topics: ["testing"],
		...overrides,
	} as Character;
}

/**
 * Assert that a promise rejects.
 *
 * @param promise - The promise expected to reject
 * @param pattern - Optional string or RegExp the error message must match
 * @returns The caught Error
 */
export async function expectRejection(
	promise: Promise<unknown>,
	pattern?: string | RegExp,
): Promise<Error> {
	try {
		await promise;
		throw new Error("Expected promise to reject but it resolved");
	} catch (err) {
		// Re-throw our own sentinel
		if (
			err instanceof Error &&
			err.message === "Expected promise to reject but it resolved"
		) {
			throw err;
		}

		if (!(err instanceof Error)) {
			throw new Error(`Expected Error but got: ${typeof err}`);
		}

		if (pattern) {
			if (typeof pattern === "string") {
				if (!err.message.includes(pattern)) {
					throw new Error(
						`Expected error to include "${pattern}" but got: ${err.message}`,
					);
				}
			} else if (!pattern.test(err.message)) {
				throw new Error(
					`Expected error to match ${pattern} but got: ${err.message}`,
				);
			}
		}

		return err;
	}
}

export function generateTestId(): string {
	return crypto.randomUUID();
}

export async function measureTime<T>(
	fn: () => Promise<T>,
): Promise<{ result: T; durationMs: number }> {
	const start = performance.now();
	const result = await fn();
	return { result, durationMs: performance.now() - start };
}

/**
 * Retry a function with exponential backoff.
 */
export async function retry<T>(
	fn: () => Promise<T>,
	options: { maxRetries?: number; baseDelay?: number } = {},
): Promise<T> {
	const { maxRetries = 3, baseDelay = 100 } = options;
	let lastError: Error | undefined;
	const totalAttempts = maxRetries + 1; // initial + retries
	for (let i = 0; i < totalAttempts; i++) {
		try {
			return await fn();
		} catch (err) {
			lastError = err as Error;
			if (i < totalAttempts - 1) {
				const delay = baseDelay * 2 ** i;
				await new Promise((resolve) => setTimeout(resolve, delay));
			}
		}
	}
	throw lastError;
}

const WORDS = [
	"the",
	"quick",
	"brown",
	"fox",
	"jumps",
	"over",
	"lazy",
	"dog",
	"hello",
	"world",
	"test",
	"data",
	"random",
	"sentence",
	"generate",
	"alpha",
	"beta",
	"gamma",
	"delta",
	"epsilon",
	"zeta",
	"theta",
];

export const testDataGenerators = {
	uuid: () => crypto.randomUUID(),
	text: (prefix = "test") =>
		`${prefix}-${Math.random().toString(36).slice(2, 8)}`,
	number: (min = 0, max = 100) =>
		Math.floor(Math.random() * (max - min + 1)) + min,
	randomString: (length = 10): string => {
		const chars =
			"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
		let result = "";
		for (let i = 0; i < length; i++) {
			result += chars.charAt(Math.floor(Math.random() * chars.length));
		}
		return result;
	},
	randomSentence: (): string => {
		const wordCount = 5 + Math.floor(Math.random() * 10); // 5–14 words
		const words: string[] = [];
		for (let i = 0; i < wordCount; i++) {
			words.push(WORDS[Math.floor(Math.random() * WORDS.length)]);
		}
		return words.join(" ");
	},
};

/**
 * Wait for a condition to become true.
 */
export async function waitFor(
	conditionFn: () => boolean | Promise<boolean>,
	options: { timeout?: number; interval?: number } = {},
): Promise<void> {
	const { timeout = 5000, interval = 100 } = options;
	const start = Date.now();
	while (Date.now() - start < timeout) {
		if (await conditionFn()) return;
		await new Promise((resolve) => setTimeout(resolve, interval));
	}
	throw new Error(`Condition not met within ${timeout}ms timeout`);
}

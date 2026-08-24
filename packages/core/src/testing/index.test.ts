/**
 * Behavioral contract for the core testing barrel (`src/testing/index.ts`):
 * proves every runtime export is wired to its owning module and that the
 * re-exported helpers behave when driven through the barrel itself. Real
 * implementations only — no mocks of the subject under test.
 */
import { describe, expect, it, test } from "vitest";
import { ADVERSARIAL_KINDS } from "./adversarial-model-fixtures.ts";
import {
	createCanvas2DContext,
	createMemoryStorage,
	hasStorageApi,
	installCanvasShims,
	installMediaElementShims,
	suppressReactTestConsoleErrors,
} from "./browser-mocks.ts";
import { REQUIRED_INTERACTION_CONFORMANCE_CASES } from "./computer-use-conformance.ts";
import { describeIf, itIf, testIf } from "./conditional-tests.ts";
import {
	actionSlug,
	finalMessageUserText,
	matchesScenarioInput,
} from "./deterministic-action-fixtures.ts";
import * as testingBarrel from "./index.ts";
import { canBindLoopback } from "./loopback.ts";
import { MOCK_AGENT_ID as DIRECT_MOCK_AGENT_ID } from "./mock-runtime.ts";
import {
	createTestPgliteDataDir,
	isInMemoryPgliteDataDir,
	testPgliteStorageMode,
} from "./pglite-storage.ts";
import {
	createDeferred as directCreateDeferred,
	envSnapshot,
	saveEnv,
	sleep,
	withTimeout,
} from "./shared-test-utils.ts";
import {
	createTestCharacter,
	createTestMemory,
	waitFor as directWaitFor,
	expectRejection,
	generateTestId,
	measureTime,
	retry,
	testDataGenerators,
	waitFor,
} from "./test-helpers.ts";

const RUNTIME_EXPORT_NAMES = [
	"ADVERSARIAL_KIND_DESCRIPTIONS",
	"ADVERSARIAL_KINDS",
	"adversarialActionRouteFixtures",
	"adversarialPlannerFixture",
	"createCanvas2DContext",
	"createMemoryStorage",
	"hasStorageApi",
	"installCanvasShims",
	"installMediaElementShims",
	"suppressReactTestConsoleErrors",
	"REQUIRED_INTERACTION_CONFORMANCE_CASES",
	"runInteractionAdapterConformance",
	"runInteractionLeaseConformance",
	"describeIf",
	"itIf",
	"testIf",
	"actionSlug",
	"benignExternalMessageFixture",
	"finalMessageUserText",
	"matchesScenarioInput",
	"registerStrictActionRouteFixtures",
	"stage1ResponseHandlerFixture",
	"strictActionRouteFixtures",
	"strictClarificationFixture",
	"strictEvaluatorFixture",
	"strictMultiToolRouteFixtures",
	"strictScheduledRenderFixture",
	"strictTerminalReplyFixture",
	"applyDeterministicModelFixtureBehavior",
	"createDeterministicModelFixtureRegistry",
	"createDeterministicModelPlugin",
	"getAppCoreSourceRoot",
	"getAutonomousSourceRoot",
	"getElizaCoreEntry",
	"getInstalledPackageEntry",
	"getInstalledPackageNamedExport",
	"getInstalledPackageRoot",
	"getSharedSourceRoot",
	"getUiSourceRoot",
	"resolveModuleEntry",
	"createConversation",
	"postConversationMessage",
	"readConversationId",
	"req",
	"detectInferenceProviders",
	"hasInferenceProvider",
	"requireInferenceProvider",
	"createIntegrationTestRuntime",
	"DEFAULT_TEST_CHARACTER",
	"withTestRuntime",
	"availableProviderNames",
	"CLI_SUBSCRIPTION_SENTINEL_API_KEY",
	"cliBackendCredentialsPath",
	"cliBackendCredentialsPaths",
	"isLiveTestEnabled",
	"requireLiveProvider",
	"selectLiveProvider",
	"canBindLoopback",
	"createMockRuntime",
	"MOCK_AGENT_ID",
	"createTestRuntimeWithModelProvider",
	"createOllamaModelHandlers",
	"isOllamaAvailable",
	"listOllamaModels",
	"createTestRuntime",
	"createTestPgliteDataDir",
	"isInMemoryPgliteDataDir",
	"testPgliteStorageMode",
	"findButtonByText",
	"flush",
	"text",
	"textOf",
	"createDiscordTestClient",
	"createTelegramTestBot",
	"sendDiscordChannelMessage",
	"sendDiscordDM",
	"waitForDiscordMessage",
	"createRealTestRuntime",
	"createDeferred",
	"envSnapshot",
	"saveEnv",
	"sleep",
	"withTimeout",
	"createTestCharacter",
	"createTestMemory",
	"expectRejection",
	"generateTestId",
	"measureTime",
	"retry",
	"testDataGenerators",
	"waitFor",
] as const;

const barreled = testingBarrel as Record<string, unknown>;

describe("testing barrel exports", () => {
	it("re-exports every runtime symbol as a defined value", () => {
		for (const name of RUNTIME_EXPORT_NAMES) {
			expect(
				barreled[name],
				`barrel must export ${name} as a runtime value`,
			).not.toBeUndefined();
		}
	});

	it("wires each export to its owning module, not a copy", () => {
		expect(barreled.createDeferred).toBe(directCreateDeferred);
		expect(barreled.waitFor).toBe(directWaitFor);
		expect(barreled.MOCK_AGENT_ID).toBe(DIRECT_MOCK_AGENT_ID);
		expect(barreled.testPgliteStorageMode).toBe(testPgliteStorageMode);
		expect(barreled.describeIf).toBe(describeIf);
		expect(barreled.createMemoryStorage).toBe(createMemoryStorage);
		expect(barreled.actionSlug).toBe(actionSlug);
		expect(barreled.canBindLoopback).toBe(canBindLoopback);
		expect(barreled.ADVERSARIAL_KINDS).toBe(ADVERSARIAL_KINDS);
	});
});

describe("barrel condition-gated wrappers", () => {
	it("passes through the real runners when the condition holds", () => {
		expect(describeIf(true)).toBe(describe);
		expect(itIf(true)).toBe(it);
		expect(testIf(true)).toBe(test);
	});

	it("falls back to a runner distinct from the passthrough", () => {
		expect(typeof describeIf(false)).toBe("function");
		expect(describeIf(false) === describe).toBe(false);
		expect(itIf(false) === it).toBe(false);
		expect(testIf(false) === test).toBe(false);
	});
});

// Behavioral proof of the false path: if the skip fallback ever regressed to
// the real runner, these bodies execute and fail the suite via unreachable().
describeIf(process.env.BARREL_SKIP_PROOF_ENABLED === "1")(
	"barrel conditional skip guard (describeIf)",
	() => {
		it("must never run while the predicate is false", () => {
			expect.unreachable();
		});
	},
);
itIf(false)("barrel conditional skip guard (itIf)", () => {
	expect.unreachable();
});

describe("barrel prompt-envelope helpers", () => {
	it("returns bare text unchanged through finalMessageUserText", () => {
		expect(finalMessageUserText("hello world")).toBe("hello world");
	});

	it("strips the message:user marker and provider/event suffix", () => {
		const prompt = "message:user:\nWhat is the plan?\n\nprovider: openai\n";
		expect(finalMessageUserText(prompt)).toBe("What is the plan?");
	});

	it("unwraps external content envelopes to the user turn", () => {
		const prompt =
			"system preamble<<<EXTERNAL_UNTRUSTED_CONTENT>>>context notes\n---\nactual user input<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>";
		expect(finalMessageUserText(prompt)).toBe("actual user input");
	});

	it("matchesScenarioInput compares normalized user text exactly", () => {
		const matcher = matchesScenarioInput("ping");
		expect(matcher("message:user:\nping\n\nevent: tick")).toBe(true);
		expect(matcher("message:user:\npong\n\nevent: tick")).toBe(false);
	});

	it("slugifies action names for stable fixture names", () => {
		expect(actionSlug("TRANSFER_TOKEN")).toBe("transfer-token");
		expect(actionSlug("Foo Bar 42")).toBe("foo-bar-42");
	});
});

describe("barrel browser storage shims", () => {
	it("round-trips values through createMemoryStorage", () => {
		const storage = createMemoryStorage();
		expect(storage.getItem("missing")).toBeNull();
		storage.setItem("alpha", "one");
		storage.setItem("beta", "two");
		expect(storage.getItem("alpha")).toBe("one");
		expect(storage.length).toBe(2);
		expect(storage.key(0)).toBe("alpha");
		storage.removeItem("alpha");
		expect(storage.getItem("alpha")).toBeNull();
		storage.clear();
		expect(storage.length).toBe(0);
	});

	it("hasStorageApi accepts real Storage shims and rejects lookalikes", () => {
		expect(hasStorageApi(createMemoryStorage())).toBe(true);
		expect(hasStorageApi({})).toBe(false);
		expect(hasStorageApi(null)).toBe(false);
		expect(hasStorageApi(undefined)).toBe(false);
	});

	it("exposes canvas shims as callable functions", () => {
		expect(typeof createCanvas2DContext).toBe("function");
		expect(typeof installCanvasShims).toBe("function");
		expect(typeof installMediaElementShims).toBe("function");
		expect(typeof suppressReactTestConsoleErrors).toBe("function");
	});
});

describe("barrel PGLite storage policy", () => {
	it("defaults to memory mode for unset, empty, and explicit memory values", () => {
		const env = envSnapshot(["ELIZA_TEST_PGLITE_STORAGE"]);
		try {
			delete process.env.ELIZA_TEST_PGLITE_STORAGE;
			expect(testPgliteStorageMode()).toBe("memory");
			process.env.ELIZA_TEST_PGLITE_STORAGE = "";
			expect(testPgliteStorageMode()).toBe("memory");
			process.env.ELIZA_TEST_PGLITE_STORAGE = "memory";
			expect(testPgliteStorageMode()).toBe("memory");
		} finally {
			env.restore();
		}
	});

	it("selects disk mode explicitly and rejects unknown modes", () => {
		const env = envSnapshot(["ELIZA_TEST_PGLITE_STORAGE"]);
		try {
			process.env.ELIZA_TEST_PGLITE_STORAGE = "disk";
			expect(testPgliteStorageMode()).toBe("disk");
			process.env.ELIZA_TEST_PGLITE_STORAGE = "ssd";
			expect(() => testPgliteStorageMode()).toThrow(
				'ELIZA_TEST_PGLITE_STORAGE must be "memory" or "disk", got "ssd"',
			);
		} finally {
			env.restore();
		}
	});

	it("classifies data dirs by their memory URL prefix", () => {
		expect(isInMemoryPgliteDataDir("memory://agent-1-2")).toBe(true);
		expect(isInMemoryPgliteDataDir("/tmp/eliza-pglite-abc")).toBe(false);
		expect(isInMemoryPgliteDataDir("")).toBe(false);
	});

	it("allocates unique memory URLs per runtime while memory mode holds", () => {
		const env = envSnapshot(["ELIZA_TEST_PGLITE_STORAGE"]);
		try {
			process.env.ELIZA_TEST_PGLITE_STORAGE = "memory";
			const first = createTestPgliteDataDir("barrel-a-");
			const second = createTestPgliteDataDir("barrel-b-");
			expect(first.startsWith("memory://barrel-a-")).toBe(true);
			expect(second.startsWith("memory://barrel-b-")).toBe(true);
			expect(first).not.toBe(second);
		} finally {
			env.restore();
		}
	});
});

describe("barrel shared async utilities", () => {
	it("sleep resolves after the requested delay", async () => {
		await expect(sleep(1)).resolves.toBeUndefined();
	});

	it("createDeferred resolves its promise from the external resolver", async () => {
		const deferred = testingBarrel.createDeferred<number>();
		deferred.resolve(7);
		await expect(deferred.promise).resolves.toBe(7);
	});

	it("withTimeout keeps fast promises and rejects slow ones with detail", async () => {
		await expect(withTimeout(Promise.resolve("fast"), 500)).resolves.toBe(
			"fast",
		);
		await expect(
			withTimeout(new Promise(() => {}), 20, "BarrelOp"),
		).rejects.toThrow("BarrelOp timed out after 20ms");
	});

	it("retry returns the first success after transient failures", async () => {
		let attempts = 0;
		const result = await retry(
			() => {
				attempts += 1;
				if (attempts < 3) {
					return Promise.reject(new Error(`attempt ${attempts} failed`));
				}
				return Promise.resolve("recovered");
			},
			{ maxRetries: 5, baseDelay: 1 },
		);
		expect(result).toBe("recovered");
		expect(attempts).toBe(3);
	});

	it("retry exhausts its budget and throws the last error", async () => {
		let attempts = 0;
		await expect(
			retry(
				() => {
					attempts += 1;
					return Promise.reject(new Error("always fails"));
				},
				{ maxRetries: 2, baseDelay: 1 },
			),
		).rejects.toThrow("always fails");
		expect(attempts).toBe(3);
	});

	it("measureTime reports the wrapped result and a numeric duration", async () => {
		const { result, durationMs } = await measureTime(async () => "payload");
		expect(result).toBe("payload");
		expect(typeof durationMs).toBe("number");
		expect(durationMs).toBeGreaterThanOrEqual(0);
	});

	it("waitFor returns once the condition flips true", async () => {
		let ready = false;
		setTimeout(() => {
			ready = true;
		}, 10);
		await expect(
			waitFor(() => ready, { timeout: 1000, interval: 5 }),
		).resolves.toBeUndefined();
	});

	it("waitFor throws the timeout error when the condition never holds", async () => {
		await expect(
			waitFor(() => false, { timeout: 25, interval: 5 }),
		).rejects.toThrow("Condition not met within 25ms timeout");
	});

	it("expectRejection surfaces the original Error and validates messages", async () => {
		const error = await expectRejection(
			Promise.reject(new Error("boom")),
			"oo",
		);
		expect(error).toBeInstanceOf(Error);
		expect(error.message).toBe("boom");
	});

	it("saveEnv restores prior environment state", () => {
		process.env.BARREL_ENV_PROBE = "original";
		const saved = saveEnv("BARREL_ENV_PROBE");
		process.env.BARREL_ENV_PROBE = "changed";
		expect(process.env.BARREL_ENV_PROBE).toBe("changed");
		saved.restore();
		expect(process.env.BARREL_ENV_PROBE).toBe("original");
		delete process.env.BARREL_ENV_PROBE;
	});
});

describe("barrel test-data helpers", () => {
	it("generateTestId yields unique UUID-shaped identifiers", () => {
		const first = generateTestId();
		const second = generateTestId();
		expect(first).not.toBe(second);
		expect(first).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);
	});

	it("createTestMemory maps string content and preserves explicit ids", () => {
		const entityId = generateTestId();
		const roomId = generateTestId();
		const fromString = createTestMemory({
			content: "hello",
			entityId,
			roomId,
		});
		expect(fromString.content).toEqual({ text: "hello" });
		expect(fromString.entityId).toBe(entityId);
		expect(fromString.roomId).toBe(roomId);
		expect(typeof fromString.createdAt).toBe("number");

		const fromContent = createTestMemory({ content: { text: "structured" } });
		expect(fromContent.content.text).toBe("structured");
		expect(fromContent.id).not.toBe(fromString.id);
	});

	it("createTestCharacter applies defaults and honors overrides", () => {
		const defaults = createTestCharacter();
		expect(defaults.name).toBe("TestAgent");
		expect(defaults.bio).toEqual(["Test agent"]);
		expect(defaults.topics).toEqual(["testing"]);

		const overridden = createTestCharacter({
			name: "Custom",
			topics: ["ops"],
		});
		expect(overridden.name).toBe("Custom");
		expect(overridden.topics).toEqual(["ops"]);
		expect(overridden.bio).toEqual(["Test agent"]);
	});

	it("testDataGenerators produce shaped, random output", () => {
		const random = testDataGenerators.randomString(12);
		expect(random).toHaveLength(12);
		expect(random).toMatch(/^[A-Za-z0-9]+$/);
		expect(random).not.toBe(testDataGenerators.randomString(12));
		expect(testDataGenerators.uuid()).not.toBe(generateTestId());
		expect(testDataGenerators.randomSentence()).toMatch(/^[a-z]+( [a-z]+)*$/);
	});
});

describe("barrel fixture constants", () => {
	it("publishes the adversarial catalogue verbatim", () => {
		expect([...ADVERSARIAL_KINDS]).toEqual([
			"malformed-json",
			"wrong-tool",
			"hallucinated-tool",
			"empty",
			"truncated",
		]);
	});

	it("requires at least one interaction conformance case", () => {
		expect(Array.isArray(REQUIRED_INTERACTION_CONFORMANCE_CASES)).toBe(true);
		expect(REQUIRED_INTERACTION_CONFORMANCE_CASES.length).toBeGreaterThan(0);
		for (const caseName of REQUIRED_INTERACTION_CONFORMANCE_CASES) {
			expect(typeof caseName).toBe("string");
			expect(caseName.length).toBeGreaterThan(0);
		}
	});

	it("keeps the mock agent id stable across barrel and module", () => {
		expect(DIRECT_MOCK_AGENT_ID).toBe("00000000-0000-0000-0000-000000000000");
	});
});

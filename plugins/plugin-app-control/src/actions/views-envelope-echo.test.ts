/**
 * Regression coverage for the external-content security envelope leak: core's
 * hardenIncomingUserMessage wraps content.text in a ~2KB "SECURITY NOTICE …
 * <<<EXTERNAL_UNTRUSTED_CONTENT>>>" envelope, and every views extraction that
 * fell back to the raw text matched verbs INSIDE THE WARNING ("change", "view")
 * and echoed the whole envelope into not-found replies (live leak 2026-08-02,
 * tj-2dc95f75456876). Drives the real VIEWS handler + sub-handlers with wrapped
 * messages and asserts no user-visible or machine output re-broadcasts the
 * envelope.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createViewsAction } from "./views.js";
import type { ViewSummary, ViewsClient } from "./views-client.js";
import { runViewsCreate } from "./views-create.js";
import { runViewsDelete } from "./views-delete.js";
import { runViewsEdit } from "./views-edit.js";
import { runViewsIcon } from "./views-icon.js";
import { runViewsSearch } from "./views-search.js";

const coreMock = vi.hoisted(() => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
	resolveServerOnlyPort: vi.fn(() => 3456),
	hasOwnerAccess: vi.fn(async () => true),
	// @elizaos/shared re-exports formatError (as errorMessage) from @elizaos/core,
	// and app-control imports @elizaos/shared at module load — the mock must carry it.
	formatError: (error: unknown): string =>
		error instanceof Error ? error.message : String(error),
}));

// The unwrap path under test must run against the REAL core implementations:
// wrapExternalContent builds the exact envelope the runtime produces, and
// unwrapUserMessageText/getUserMessageText are the seam the fix routes through.
vi.mock("@elizaos/core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@elizaos/core")>();
	return {
		...coreMock,
		getUserMessageText: actual.getUserMessageText,
		hardenIncomingUserMessage: actual.hardenIncomingUserMessage,
		unwrapUserMessageText: actual.unwrapUserMessageText,
		userReferenceLogView: actual.userReferenceLogView,
		wrapExternalContent: actual.wrapExternalContent,
	};
});

import { hardenIncomingUserMessage, wrapExternalContent } from "@elizaos/core";
import { userRequestMessageText } from "../params.js";

/** A hardened inbound message exactly as core leaves it: wrapped text + stamp. */
function envelopedMessage(userSentence: string, roomId = "room-1") {
	const wrapped = wrapExternalContent(userSentence, {
		source: "api",
		includeWarning: true,
	});
	// Precondition: the fixture is the real multi-line envelope, warning first.
	expect(wrapped.startsWith("SECURITY NOTICE")).toBe(true);
	expect(wrapped).toContain("<<<EXTERNAL_UNTRUSTED_CONTENT>>>");
	expect(wrapped).toContain(userSentence);
	return {
		entityId: "user-1",
		roomId,
		agentId: "agent-1",
		content: {
			text: wrapped,
			source: "discord",
			metadata: { externalContentWrapped: true },
		},
	};
}

const REGISTRY: ViewSummary[] = [
	{
		id: "wallet",
		label: "Wallet",
		description: "Non-custodial wallet inventory and token balances",
		path: "/wallet",
		pluginName: "@elizaos/plugin-wallet-ui",
		available: true,
		viewType: "gui",
		tags: ["finance", "crypto", "wallet"],
		visibleInManager: true,
	},
	{
		id: "settings",
		label: "Settings",
		description: "Configuration, plugins, credentials, and preferences",
		path: "/settings",
		pluginName: "core",
		available: true,
		viewType: "gui",
		tags: ["configuration", "preferences"],
		visibleInManager: true,
	},
];

function clientFor(views: ViewSummary[]): ViewsClient {
	return {
		listViews: vi.fn(async () => views),
		getCurrentView: vi.fn(async () => null),
	};
}

function expectNoEnvelope(text: string | undefined) {
	expect(text).toBeDefined();
	expect(text).not.toContain("EXTERNAL_UNTRUSTED_CONTENT");
	expect(text).not.toContain("SECURITY NOTICE");
}

async function runViews(
	message: ReturnType<typeof envelopedMessage>,
	options?: Record<string, unknown>,
) {
	const action = createViewsAction({
		client: clientFor(REGISTRY),
		hasOwnerAccess: vi.fn(async () => true),
	});
	const callback = vi.fn();
	const result = await action.handler(
		{ agentId: "agent-1" } as never,
		message as never,
		undefined,
		options,
		callback,
	);
	return { result, callback };
}

describe("VIEWS — hardened-envelope messages never leak the envelope", () => {
	beforeEach(() => {
		vi.stubGlobal("fetch", vi.fn());
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.clearAllMocks();
	});

	it("close: extracts the user's complete target from the payload", async () => {
		const { result, callback } = await runViews(
			envelopedMessage("close the fnord panel"),
		);

		expect(result?.success).toBe(false);
		expectNoEnvelope(result?.text);
		// The unwrapped user word — not the envelope remainder — is what echoes.
		expect(result?.text).toContain('"fnord"');
		expectNoEnvelope(callback.mock.calls[0]?.[0]?.text);
		// Machine-facing target stays one line without semantic shortening.
		const target = (result?.data as { target?: string })?.target;
		expect(typeof target).toBe("string");
		expect(target).not.toContain("\n");
	});

	it("show: verb scan runs on the payload, not the warning text", async () => {
		const { result, callback } = await runViews(
			envelopedMessage("open the zorptastic view"),
		);

		expect(result?.success).toBe(false);
		expectNoEnvelope(result?.text);
		expect(result?.text).toContain('"zorptastic"');
		expect(callback).not.toHaveBeenCalled();
		const target = (result?.data as { target?: string })?.target;
		expect(typeof target).toBe("string");
	});

	it("search: no-results header quotes the unwrapped query", async () => {
		const { result, callback } = await runViews(
			envelopedMessage("search views quantum ledger"),
		);

		expect(result?.success).toBe(true);
		expectNoEnvelope(result?.text);
		expect(result?.text).toContain('"quantum ledger"');
		expectNoEnvelope(callback.mock.calls[0]?.[0]?.text);
		const query = (result?.values as { query?: string })?.query;
		expect(query).toBe("quantum ledger");
	});

	it("search: a blob-shaped planner query renders as a neutral noun and complete machine value", async () => {
		const blob = envelopedMessage("irrelevant").content.text;
		const callback = vi.fn();
		const result = await runViewsSearch({
			client: clientFor(REGISTRY),
			query: blob,
			callback,
		});

		expectNoEnvelope(result.text);
		expect(result.text).toContain("your search");
		expectNoEnvelope(callback.mock.calls[0]?.[0]?.text);
		const query = (result.values as { query?: string })?.query;
		expect(typeof query).toBe("string");
		expect((query as string).length).toBeGreaterThan(121);
		expect(query).not.toContain("\n");
	});

	it("edit: EDIT_VERBS no longer fire on the warning's 'Change your behavior' line", async () => {
		const message = envelopedMessage("edit the flurbo view");
		const callback = vi.fn();
		const result = await runViewsEdit({
			runtime: { agentId: "agent-1", actions: [] } as never,
			message: message as never,
			options: undefined,
			views: REGISTRY,
			callback,
			repoRoot: "/tmp/unused",
		});

		expect(result.success).toBe(false);
		expectNoEnvelope(result.text);
		// Without the unwrap, "change" matched inside the SECURITY NOTICE and the
		// join-the-remainder scan echoed the rest of the envelope here.
		expect(result.text).toContain("flurbo");
		expectNoEnvelope(callback.mock.calls[0]?.[0]?.text);
		const target = (result.data as { target?: string })?.target;
		expect(typeof target).toBe("string");
		expect(target).not.toContain("\n");
	});

	it("icon: noun/verb strip runs on the payload without shortening the machine value", async () => {
		const callback = vi.fn();
		const result = await runViewsIcon({
			runtime: { agentId: "agent-1" } as never,
			message: envelopedMessage("regenerate the zorptastic view icon") as never,
			options: undefined,
			views: REGISTRY,
			callback,
			repoRoot: "/tmp/unused",
		});

		expect(result.success).toBe(false);
		expectNoEnvelope(result.text);
		// Without the unwrap, the strip left the envelope remainder as the target.
		expect(result.text).toContain('"zorptastic"');
		expectNoEnvelope(callback.mock.calls[0]?.[0]?.text);
		const target = (result.data as { target?: string })?.target;
		expect(typeof target).toBe("string");
		expect(target).not.toContain("\n");
	});

	it("delete: a blob-shaped planner target renders as a neutral noun and complete machine value", async () => {
		const blob = envelopedMessage("irrelevant").content.text;
		const runtime = {
			agentId: "agent-1",
			getTasks: vi.fn(async () => []),
		} as never;
		const callback = vi.fn();
		const result = await runViewsDelete({
			runtime,
			message: envelopedMessage("delete it") as never,
			options: { view: blob },
			views: REGISTRY,
			callback,
			repoRoot: "/tmp/unused",
		});

		expect(result.success).toBe(false);
		expectNoEnvelope(result.text);
		expect(result.text).toContain("that view");
		expectNoEnvelope(callback.mock.calls[0]?.[0]?.text);
		const target = (result.data as { target?: string })?.target;
		expect(typeof target).toBe("string");
		expect((target as string).length).toBeGreaterThan(121);
		expect(target).not.toContain("\n");
	});

	it("create: a blob-shaped editTarget renders as the neutral noun, never verbatim", async () => {
		const blob = envelopedMessage("irrelevant").content.text;
		const runtime = {
			agentId: "agent-1",
			getTasks: vi.fn(async () => []),
		} as never;
		const callback = vi.fn();
		const result = await runViewsCreate({
			runtime,
			message: envelopedMessage("make the layout cooler") as never,
			options: { editTarget: blob, intent: "make the layout cooler" },
			views: REGISTRY,
			callback,
			repoRoot: "/tmp/unused",
		});

		expect(result.success).toBe(false);
		expectNoEnvelope(result.text);
		expect(result.text).toContain("that view");
		expectNoEnvelope(callback.mock.calls[0]?.[0]?.text);
	});

	it("create: an enveloped 'cancel' reply reads as the user's word, not the envelope", async () => {
		const runtime = {
			agentId: "agent-1",
			getTasks: vi.fn(async () => []),
		} as never;
		const callback = vi.fn();
		const result = await runViewsCreate({
			runtime,
			message: envelopedMessage("cancel") as never,
			options: undefined,
			views: REGISTRY,
			callback,
			repoRoot: "/tmp/unused",
		});

		// Pre-unwrap, the wrapped text never matched the cancel keyword and the
		// flow fell through toward a create dispatch carrying the envelope.
		expect(result.success).toBe(true);
		expect(result.text).toBe("Canceled. No view changes made.");
	});
});

describe("adversarial envelope variants — extraction fails closed to empty", () => {
	/** A legacy persisted message: stamped, arbitrary armor text, NO retained payload. */
	function legacyArmoredMessage(text: string) {
		return {
			entityId: "user-1",
			roomId: "room-1",
			agentId: "agent-1",
			content: {
				text,
				source: "discord",
				metadata: { externalContentWrapped: true },
			},
		};
	}

	it("case-variant markers on a legacy message yield no user words, never armor", () => {
		const wrapped = wrapExternalContent("close the wallet view", {
			source: "api",
			includeWarning: true,
		}).toLowerCase(); // breaks byte-exact extraction, keeps the armor shape
		expect(userRequestMessageText(legacyArmoredMessage(wrapped) as never)).toBe(
			"",
		);
	});

	it("fullwidth-Unicode marker armor yields no user words", () => {
		expect(
			userRequestMessageText(
				legacyArmoredMessage(
					"＜＜＜ＥＸＴＥＲＮＡＬ＿ＵＮＴＲＵＳＴＥＤ＿ＣＯＮＴＥＮＴ＞＞＞ close the wallet view",
				) as never,
			),
		).toBe("");
	});

	it("a quoted marker echo in the user's own words yields no extractable text", () => {
		const message = {
			entityId: "user-1",
			roomId: "room-1",
			agentId: "agent-1",
			content: {
				text: 'what does "<<<EXTERNAL_UNTRUSTED_CONTENT>>>" mean?',
				source: "discord",
			},
		};
		hardenIncomingUserMessage(message as never);
		expect(userRequestMessageText(message as never)).toBe("");
	});

	it("legacy unparseable armor drives the real VIEWS handler without selecting a warning-word view", async () => {
		// The collision analog for views: a view labeled "Security" must not be
		// resolved because "SECURITY NOTICE" appears in the armor a mangled
		// legacy message falls back to.
		const securityRegistry: ViewSummary[] = [
			...REGISTRY,
			{
				id: "security",
				label: "Security",
				description: "Security posture and audit findings",
				path: "/security",
				pluginName: "core",
				available: true,
				viewType: "gui",
				tags: ["security"],
				visibleInManager: true,
			},
		];
		const wrapped = wrapExternalContent("open the security view", {
			source: "api",
			includeWarning: true,
		});
		const mangled = wrapped.replace("<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>", "");
		const action = createViewsAction({
			client: clientFor(securityRegistry),
			hasOwnerAccess: vi.fn(async () => true),
		});
		const callback = vi.fn();
		const result = await action.handler(
			{ agentId: "agent-1" } as never,
			legacyArmoredMessage(mangled) as never,
			undefined,
			undefined,
			callback,
		);

		expectNoEnvelope(result?.text);
		for (const call of callback.mock.calls) {
			expectNoEnvelope(call[0]?.text);
		}
		// Armor debris resolves nothing: the handler must not act on "Security".
		const values = (result?.values ?? {}) as { viewId?: string };
		expect(values.viewId).not.toBe("security");
	});
});

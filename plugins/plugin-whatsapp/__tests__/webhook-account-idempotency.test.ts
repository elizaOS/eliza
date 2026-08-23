/**
 * Verifies WhatsApp Cloud API webhook account routing, durable inbound
 * delivery idempotency with CAS fencing and restart convergence, and
 * account-slice acceptance paths (named-account credential inheritance,
 * duplicate normalized account ids, account-bound send/status/recovery).
 *
 * The deterministic harness models the adapter's unique insert and atomic
 * document compare-and-swap contract. A separate PGLite suite exercises the
 * production adapter and schema without mocks.
 */
import {
	type IAgentRuntime,
	type Memory,
	type MemoryMetadata,
	type UUID,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { WhatsAppConnectorService } from "../src/runtime-service";
import {
	createInboundClaimId,
	isStaleProcessing,
	type InboundClaimState,
	tryClaim,
} from "../src/inbound-claim";

// ── Shared in-memory store ────────────────────────────────────────────

interface StoreEntry {
	memory: Memory;
	table: string;
	unique?: boolean;
}

class SharedMemoryStore {
	private entries = new Map<string, StoreEntry>();

	async getMemoryById(id: UUID): Promise<Memory | null> {
		const entry = this.entries.get(String(id));
		return entry ? { ...entry.memory } : null;
	}

	async createMemory(
		memory: Memory,
		table: string,
		unique?: boolean,
	): Promise<UUID> {
		const id = String(memory.id ?? crypto.randomUUID());
		if (unique && this.entries.has(id)) {
			// ON CONFLICT DO NOTHING — the existing row persists.
			return id as UUID;
		}
		this.entries.set(id, { memory: { ...memory, id: id as UUID }, table, unique });
		return id as UUID;
	}

	async updateMemory(
		memory: Partial<Memory> & { id: UUID; metadata?: MemoryMetadata },
	): Promise<boolean> {
		const entry = this.entries.get(String(memory.id));
		if (!entry) return false;
		entry.memory = { ...entry.memory, ...memory } as Memory;
		return true;
	}

	async compareAndSwapDocument(params: {
		documentId: UUID;
		expected: { revision: number; roomId: UUID; entityId: UUID; scope: string };
		replacement: Memory;
	}): Promise<{ status: "updated" | "conflict" | "not_found" }> {
		const entry = this.entries.get(String(params.documentId));
		if (!entry) return { status: "not_found" };
		const metadata = entry.memory.metadata as Record<string, unknown> | undefined;
		if (
			metadata?.documentRevision !== params.expected.revision ||
			metadata.scope !== params.expected.scope ||
			entry.memory.roomId !== params.expected.roomId ||
			entry.memory.entityId !== params.expected.entityId
		) {
			return { status: "conflict" };
		}
		entry.memory = { ...params.replacement };
		return { status: "updated" };
	}

	/** Snapshot for assertions. */
	snapshot(): Map<string, StoreEntry> {
		return new Map(this.entries);
	}

	/** Clear for test isolation. */
	clear(): void {
		this.entries.clear();
	}

	getClaimState(id: UUID): InboundClaimState | null {
		const entry = this.entries.get(String(id));
		if (!entry) return null;
		const raw = (entry.memory.metadata as Record<string, unknown>)?.whatsappClaim;
		return (raw as InboundClaimState) ?? null;
	}
}

// ── Harness ───────────────────────────────────────────────────────────

type CloudAccountConfig = {
	accountId: string;
	transport: "cloudapi";
	accessToken: string;
	phoneNumberId: string;
	dmPolicy: "open" | "disabled";
};

function makeRuntimeWithStore(
	store: SharedMemoryStore,
	settings: Record<string, unknown> = {},
) {
	const runtime = {
		agentId: "agent-1" as UUID,
		character: { settings },
		getSetting: vi.fn((key: string) =>
			key === "WHATSAPP_AUTO_REPLY" ? false : undefined,
		),
		getMemoryById: vi.fn(async (id: UUID) => store.getMemoryById(id)),
		createMemory: vi.fn(async (memory: Memory, table: string, unique?: boolean) =>
			store.createMemory(memory, table, unique),
		),
		updateMemory: vi.fn(
			async (memory: Partial<Memory> & { id: UUID; metadata?: MemoryMetadata }) =>
				store.updateMemory(memory),
		),
		adapter: {
			documentListQueryCapability: 3,
			getDocument: vi.fn(async ({ documentId }: { documentId: UUID }) =>
				store.getMemoryById(documentId),
			),
			compareAndSwapDocument: vi.fn(
				async (params: Parameters<SharedMemoryStore["compareAndSwapDocument"]>[0]) =>
					store.compareAndSwapDocument(params),
			),
		},
		ensureConnection: vi.fn(async () => undefined),
		ensureWorldExists: vi.fn(async () => undefined),
		ensureRoomExists: vi.fn(async () => undefined),
		messageService: { handleMessage: vi.fn(async () => undefined) },
		logger: {
			warn: vi.fn(),
			error: vi.fn(),
			info: vi.fn(),
			debug: vi.fn(),
		},
		reportError: vi.fn(),
	} as never as IAgentRuntime;

	return runtime;
}

function cloudAccount(
	accountId: string,
	phoneNumberId: string,
	dmPolicy: "open" | "disabled" = "open",
): CloudAccountConfig {
	return {
		accountId,
		transport: "cloudapi",
		accessToken: `token-${accountId}`,
		phoneNumberId,
		dmPolicy,
	};
}

function configuredService(
	runtime: IAgentRuntime,
	configs: CloudAccountConfig[] = [cloudAccount("default", "phone-default")],
): WhatsAppConnectorService {
	const service = new WhatsAppConnectorService(runtime);
	Object.assign(service, {
		defaultAccountId: "default",
		configs: new Map(configs.map((config) => [config.accountId, config])),
	});
	return service;
}

function webhook(phoneNumberId: string | undefined, messageId = "wamid.1") {
	return {
		entry: [
			{
				changes: [
					{
						value: {
							metadata: {
								display_phone_number: "+1 415 555 2671",
								...(phoneNumberId === undefined
									? {}
									: { phone_number_id: phoneNumberId }),
							},
							messages: [
								{
									from: "14155552671",
									id: messageId,
									timestamp: "1700000000",
									type: "text",
									text: { body: "hello" },
								},
							],
						},
					},
				],
			},
		],
	} as never;
}

function inflightSize(service: WhatsAppConnectorService): number {
	return (
		service as unknown as {
			inflightInboundMessageIds: Set<string>;
		}
	).inflightInboundMessageIds.size;
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("WhatsApp Cloud API webhook account routing", () => {
	it("routes messages by metadata.phone_number_id", async () => {
		const store = new SharedMemoryStore();
		const runtime = makeRuntimeWithStore(store);
		const service = configuredService(runtime, [
			cloudAccount("default", "phone-default"),
			cloudAccount("work", "phone-work"),
		]);

		await service.handleWebhook(webhook("phone-work"));

		// The first createMemory call is the durable claim; the second is
		// the inbound message. Filter to "messages" table.
		const messageCalls = (
			runtime.createMemory as ReturnType<typeof vi.fn>
		).mock.calls.filter((c) => c[1] === "messages");
		expect(messageCalls.length).toBe(1);
		const memory = messageCalls[0]?.[0] as Memory;
		expect(memory.metadata).toMatchObject({ accountId: "work" });
	});

	it.each([undefined, "phone-unknown"])(
		"fails closed for a missing or unknown phone number id: %s",
		async (phoneNumberId) => {
			const store = new SharedMemoryStore();
			const runtime = makeRuntimeWithStore(store);
			const service = configuredService(runtime, [
				cloudAccount("default", "phone-default"),
				cloudAccount("work", "phone-work"),
			]);

			await service.handleWebhook(webhook(phoneNumberId));

			// No claim or message should be created — the webhook is dropped
			// before any side effect.
			expect(runtime.createMemory).not.toHaveBeenCalled();
			expect(runtime.ensureConnection).not.toHaveBeenCalled();
		},
	);

	it("rejects duplicate Cloud API phone number configuration before connecting", async () => {
		const store = new SharedMemoryStore();
		const runtime = makeRuntimeWithStore(store, {
			whatsapp: {
				accounts: {
					alpha: {
						accessToken: "token-alpha",
						phoneNumberId: "phone-shared",
						dmPolicy: "open",
					},
					beta: {
						accessToken: "token-beta",
						phoneNumberId: "phone-shared",
						dmPolicy: "open",
					},
				},
			},
		});
		const service = new WhatsAppConnectorService(runtime);

		await expect(service.initialize()).rejects.toThrow(
			'WhatsApp Cloud API accounts "alpha" and "beta" share the same phone_number_id "phone-shared"',
		);
	});
});

describe("WhatsApp inbound delivery idempotency — durable staged claims", () => {
	it("collapses concurrent delivery of the same message within one process", async () => {
		const store = new SharedMemoryStore();
		const runtime = makeRuntimeWithStore(store);
		const service = configuredService(runtime);

		const first = service.handleWebhook(webhook("phone-default"));
		// Fire a second delivery immediately while the first is still
		// in-flight — the in-process Set must collapse it.
		const duplicate = service.handleWebhook(webhook("phone-default"));

		await Promise.all([first, duplicate]);

		expect(
			(runtime.createMemory as ReturnType<typeof vi.fn>).mock.calls.filter(
				(c) => c[1] === "messages",
			).length,
		).toBe(1);
		expect(inflightSize(service)).toBe(0);
	});

	it("skips durable duplicates across service instances (restart convergence)", async () => {
		const store = new SharedMemoryStore();

		// First instance processes the message
		const runtime1 = makeRuntimeWithStore(store);
		const service1 = configuredService(runtime1);
		await service1.handleWebhook(webhook("phone-default"));

		expect(
			(runtime1.createMemory as ReturnType<typeof vi.fn>).mock.calls.filter(
				(c) => c[1] === "messages",
			).length,
		).toBe(1);

		// Second instance (restart / second host) receives the same message.
		// The durable claim persisted by instance 1 must prevent duplicate
		// side effects.
		const runtime2 = makeRuntimeWithStore(store);
		const service2 = configuredService(runtime2);
		await service2.handleWebhook(webhook("phone-default"));

		expect(
			(runtime2.createMemory as ReturnType<typeof vi.fn>).mock.calls.filter(
				(c) => c[1] === "messages",
			).length,
		).toBe(0);
		expect(runtime2.ensureConnection).not.toHaveBeenCalled();
	});

	it("marks claim as processed after successful delivery", async () => {
		const store = new SharedMemoryStore();
		const runtime = makeRuntimeWithStore(store);
		const service = configuredService(runtime);

		await service.handleWebhook(webhook("phone-default", "wamid.processed"));

		// Find the claim memory in the store (not the message memory).
		const snapshot = store.snapshot();
		const claims = Array.from(snapshot.values()).filter(
			(e) =>
				(e.memory.metadata as Record<string, unknown>)?.whatsappClaim !==
				undefined,
		);
		expect(claims.length).toBe(1);
		const claimState = (
			claims[0].memory.metadata as Record<string, unknown>
		).whatsappClaim as InboundClaimState;
		expect(claimState.stage).toBe("processed");
	});

	it("transitions claim to failed on processing error", async () => {
		const store = new SharedMemoryStore();
		const runtime = makeRuntimeWithStore(store);
		const service = configuredService(runtime);

		// Make ensureConnection throw
		(runtime.ensureConnection as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
			new Error("connection failed"),
		);

		await expect(
			service.handleWebhook(webhook("phone-default", "wamid.failed")),
		).rejects.toThrow("connection failed");

		const snapshot = store.snapshot();
		const claims = Array.from(snapshot.values()).filter(
			(e) =>
				(e.memory.metadata as Record<string, unknown>)?.whatsappClaim !==
				undefined,
		);
		expect(claims.length).toBe(1);
		const claimState = (
			claims[0].memory.metadata as Record<string, unknown>
		).whatsappClaim as InboundClaimState;
		expect(claimState.stage).toBe("failed");
		expect(claimState.error).toBe("connection failed");
	});

	it("clears the in-flight key after policy-denied returns", async () => {
		const store = new SharedMemoryStore();
		const runtime = makeRuntimeWithStore(store);
		const service = configuredService(runtime, [
			cloudAccount("default", "phone-default", "disabled"),
		]);

		await service.handleWebhook(webhook("phone-default"));
		await service.handleWebhook(webhook("phone-default"));

		expect(inflightSize(service)).toBe(0);
	});

	it("clears the in-flight key after processing errors", async () => {
		const store = new SharedMemoryStore();
		const runtime = makeRuntimeWithStore(store);
		const service = configuredService(runtime);
		(runtime.createMemory as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
			new Error("write failed"),
		);

		await expect(
			service.handleWebhook(webhook("phone-default")),
		).rejects.toThrow("write failed");
		expect(inflightSize(service)).toBe(0);
	});

	it("fails closed when durable idempotency storage is unavailable", async () => {
		const store = new SharedMemoryStore();
		const runtime = makeRuntimeWithStore(store);
		Object.assign(runtime, { adapter: undefined });
		const service = configuredService(runtime);

		await expect(service.handleWebhook(webhook("phone-default"))).rejects.toMatchObject({
			code: "WHATSAPP_IDEMPOTENCY_STORAGE_UNAVAILABLE",
		});
		expect(runtime.ensureConnection).not.toHaveBeenCalled();
		expect(inflightSize(service)).toBe(0);
	});

	it("propagates terminal claim transition failures", async () => {
		const store = new SharedMemoryStore();
		const runtime = makeRuntimeWithStore(store);
		const service = configuredService(runtime);
		(
			runtime.adapter.compareAndSwapDocument as ReturnType<typeof vi.fn>
		).mockRejectedValueOnce(new Error("claim transition write failed"));

		await expect(service.handleWebhook(webhook("phone-default"))).rejects.toThrow(
			"claim transition write failed",
		);
		expect(inflightSize(service)).toBe(0);
	});

	it("reports a failed-state transition without hiding the processing cause", async () => {
		const store = new SharedMemoryStore();
		const runtime = makeRuntimeWithStore(store);
		const service = configuredService(runtime);
		(runtime.ensureConnection as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
			new Error("original processing failure"),
		);
		(
			runtime.adapter.compareAndSwapDocument as ReturnType<typeof vi.fn>
		).mockRejectedValueOnce(new Error("failed-state CAS failure"));

		await expect(service.handleWebhook(webhook("phone-default"))).rejects.toMatchObject({
			code: "WHATSAPP_INBOUND_CLAIM_TRANSITION_FAILED",
			cause: expect.objectContaining({ message: "original processing failure" }),
		});
		expect(runtime.reportError).toHaveBeenCalledWith(
			"plugin:whatsapp:inbound-claim",
			expect.objectContaining({ message: "failed-state CAS failure" }),
			expect.objectContaining({ externalMessageId: "wamid.1" }),
		);
		expect(inflightSize(service)).toBe(0);
	});

	it("reclaims a stale processing claim after the staleness threshold", async () => {
		const store = new SharedMemoryStore();
		const runtime = makeRuntimeWithStore(store);
		const claimId = createInboundClaimId(runtime, "default", "+14155552671", "wamid.stale");
		const initial = await tryClaim(
			runtime,
			claimId,
			"default",
			"+14155552671",
			"wamid.stale",
		);
		if (!initial.state) throw new Error("Initial deterministic claim has no state");

		// Simulate a crashed host by aging the actual claim document while
		// retaining its production namespace and revision metadata.
		const staleState: InboundClaimState = {
			...initial.state,
			claimedAt: Date.now() - 10 * 60 * 1000,
			updatedAt: Date.now() - 10 * 60 * 1000,
		};
		const claimMemory = await store.getMemoryById(claimId);
		if (!claimMemory) throw new Error("Initial deterministic claim was not stored");
		await store.updateMemory({
			id: claimId,
			metadata: {
				...claimMemory.metadata,
				whatsappClaim: staleState,
			} as unknown as MemoryMetadata,
		});
		(runtime.createMemory as ReturnType<typeof vi.fn>).mockClear();

		// isStaleProcessing should return true for this old claim
		expect(isStaleProcessing(staleState)).toBe(true);

		// A new service instance should be able to reclaim and process it
		const service = configuredService(runtime);
		await service.handleWebhook(webhook("phone-default", "wamid.stale"));

		// The message should be processed (createMemory called for messages)
		expect(
			(runtime.createMemory as ReturnType<typeof vi.fn>).mock.calls.filter(
				(c) => c[1] === "messages",
			).length,
		).toBe(1);
	});

	it("generates different claim ids for different accounts", async () => {
		const store = new SharedMemoryStore();
		const runtime = makeRuntimeWithStore(store);
		const service = configuredService(runtime, [
			cloudAccount("default", "phone-default"),
			cloudAccount("work", "phone-work"),
		]);

		await service.handleWebhook(webhook("phone-default", "wamid.shared"));
		await service.handleWebhook(webhook("phone-work", "wamid.shared"));

		// Same external message id, different accounts → both should be
		// processed because the deterministic UUID includes the accountId.
		expect(
			(runtime.createMemory as ReturnType<typeof vi.fn>).mock.calls.filter(
				(c) => c[1] === "messages",
			).length,
		).toBe(2);
	});
});

describe("WhatsApp account-slice acceptance paths", () => {
	it("named accounts never inherit base/env credentials", async () => {
		// This test verifies that named accounts with their own credentials
		// do not fall back to base/env credentials. We verify this through
		// the resolveWhatsAppAccount function behavior: a named account with
		// its own accessToken should resolve to that token, not the base
		// token.
		const store = new SharedMemoryStore();
		const runtime = makeRuntimeWithStore(store, {
			whatsapp: {
				accessToken: "base-token",
				phoneNumberId: "base-phone",
				dmPolicy: "open",
				accounts: {
					named: {
						accessToken: "named-token",
						phoneNumberId: "named-phone",
						dmPolicy: "open",
					},
				},
			},
		});

		const service = new WhatsAppConnectorService(runtime);
		await service.initialize();

		const configs = (
			service as unknown as { configs: Map<string, { accessToken: string; phoneNumberId: string }> }
		).configs;

		const namedConfig = configs.get("named");
		expect(namedConfig).toBeDefined();
		expect(namedConfig?.accessToken).toBe("named-token");
		expect(namedConfig?.phoneNumberId).toBe("named-phone");

		// Default account should inherit base credentials
		const defaultConfig = configs.get("default");
		expect(defaultConfig).toBeDefined();
		expect(defaultConfig?.accessToken).toBe("base-token");
		expect(defaultConfig?.phoneNumberId).toBe("base-phone");
	});

	it("rejects duplicate normalized account ids at startup", async () => {
		const store = new SharedMemoryStore();
		const runtime = makeRuntimeWithStore(store, {
			whatsapp: {
				accounts: {
					Alpha: {
						accessToken: "token-alpha",
						phoneNumberId: "phone-alpha",
						dmPolicy: "open",
					},
					alpha: {
						// "Alpha" normalizes to "alpha" — this is a duplicate
						accessToken: "token-alpha2",
						phoneNumberId: "phone-alpha2",
						dmPolicy: "open",
					},
				},
			},
		});

		const service = new WhatsAppConnectorService(runtime);
		await expect(service.initialize()).rejects.toThrow(
			'WhatsApp account IDs "Alpha" and "alpha" both normalize to "alpha"',
		);
	});

	it("does not inherit base provider identity when a named account omits it", async () => {
		const store = new SharedMemoryStore();
		const runtime = makeRuntimeWithStore(store, {
			whatsapp: {
				accessToken: "base-token",
				phoneNumberId: "base-phone",
				dmPolicy: "open",
				accounts: { named: { accessToken: "named-token", dmPolicy: "open" } },
			},
		});

		const service = new WhatsAppConnectorService(runtime);
		await service.initialize();
		const configs = (
			service as unknown as { configs: Map<string, { phoneNumberId: string }> }
		).configs;
		expect(configs.has("default")).toBe(true);
		expect(configs.has("named")).toBe(false);
	});

	it("account-bound webhook delivery resolves the correct account", async () => {
		const store = new SharedMemoryStore();
		const runtime = makeRuntimeWithStore(store);
		const service = configuredService(runtime, [
			cloudAccount("default", "phone-default"),
			cloudAccount("work", "phone-work"),
		]);

		// Deliver to "work" account
		await service.handleWebhook(webhook("phone-work", "wamid.work.1"));

		const messageCalls = (
			runtime.createMemory as ReturnType<typeof vi.fn>
		).mock.calls.filter((c) => c[1] === "messages");
		expect(messageCalls.length).toBe(1);
		const workMemory = messageCalls[0]?.[0] as Memory;
		expect(workMemory.metadata).toMatchObject({ accountId: "work" });

		// Deliver to "default" account with different message id
		await service.handleWebhook(webhook("phone-default", "wamid.default.1"));

		const allMessageCalls = (
			runtime.createMemory as ReturnType<typeof vi.fn>
		).mock.calls.filter((c) => c[1] === "messages");
		expect(allMessageCalls.length).toBe(2);
		const defaultMemory = allMessageCalls[1]?.[0] as Memory;
		expect(defaultMemory.metadata).toMatchObject({ accountId: "default" });
	});

	it("recovery from failed claim allows reprocessing", async () => {
		const store = new SharedMemoryStore();

		// First attempt fails
		const runtime1 = makeRuntimeWithStore(store);
		const service1 = configuredService(runtime1);
		(runtime1.ensureConnection as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
			new Error("transient failure"),
		);

		await expect(
			service1.handleWebhook(webhook("phone-default", "wamid.recover")),
		).rejects.toThrow("transient failure");

		// Verify claim is in failed state
		const snapshot = store.snapshot();
		const claims = Array.from(snapshot.values()).filter(
			(e) =>
				(e.memory.metadata as Record<string, unknown>)?.whatsappClaim !==
				undefined,
		);
		expect(claims.length).toBe(1);
		const failedState = (
			claims[0].memory.metadata as Record<string, unknown>
		).whatsappClaim as InboundClaimState;
		expect(failedState.stage).toBe("failed");

		// Second attempt (retry) should succeed — failed claims are reclaimable
		const runtime2 = makeRuntimeWithStore(store);
		const service2 = configuredService(runtime2);
		await service2.handleWebhook(webhook("phone-default", "wamid.recover"));

		expect(
			(runtime2.createMemory as ReturnType<typeof vi.fn>).mock.calls.filter(
				(c) => c[1] === "messages",
			).length,
		).toBe(1);
	});
});

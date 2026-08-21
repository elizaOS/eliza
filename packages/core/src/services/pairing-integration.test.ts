/**
 * Pairing integration tests for channel connectors that gate DMs behind
 * `dmPolicy="pairing"`. The missing-service path must fail closed so a host
 * wiring mistake cannot silently turn pairing-gated DMs into open DMs, and
 * the reply path must stay decoupled from request-row existence: churning
 * sender identities at the pending-queue cap may not re-arm the unsolicited
 * pairing-code reply. The PairingService is real; only storage is faked.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockRuntime } from "../testing/mock-runtime";
import type {
	IAgentRuntime,
	PairingAllowlistEntry,
	PairingRequest,
	UUID,
} from "../types";
import { ServiceType } from "../types/service";
import { PairingService } from "./pairing";
import { checkPairingAllowed } from "./pairing-integration";

describe("checkPairingAllowed", () => {
	it("denies when PairingService is unavailable and reports the misconfiguration", async () => {
		const reportError = vi.fn();
		const runtime = {
			getService: vi.fn(() => null),
			logger: { warn: vi.fn() },
			reportError,
		} as unknown as IAgentRuntime;

		const result = await checkPairingAllowed(runtime, {
			channel: "discord",
			senderId: "1234567890",
		});

		expect(runtime.getService).toHaveBeenCalledWith(ServiceType.PAIRING);
		expect(result).toMatchObject({
			allowed: false,
			idLabel: "userId",
			replyMessage: "Access pairing is temporarily unavailable.",
		});
		// Systemic misconfiguration must reach the agent/owner, not just a log.
		expect(reportError).toHaveBeenCalledTimes(1);
		expect(reportError.mock.calls[0][0]).toBe("pairing-integration");
	});
});

describe("checkPairingAllowed reply suppression", () => {
	const noop = () => undefined;

	/**
	 * Stateful in-memory adapter double behind a real PairingService, so the
	 * queue-cap and reply-claim behavior is exercised end to end.
	 */
	function makeHarness() {
		const requests: PairingRequest[] = [];
		const allowlist: PairingAllowlistEntry[] = [];
		const runtime = createMockRuntime({
			getPairingRequests: (async (queries) =>
				queries.map((query) => ({
					channel: query.channel,
					agentId: query.agentId,
					requests: requests.filter(
						(r) => r.channel === query.channel && r.agentId === query.agentId,
					),
				}))) as IAgentRuntime["getPairingRequests"],
			createPairingRequest: (async (request: PairingRequest) => {
				requests.push(request);
				return request.id;
			}) as IAgentRuntime["createPairingRequest"],
			updatePairingRequest: (async (updated: PairingRequest) => {
				const index = requests.findIndex((r) => r.id === updated.id);
				if (index >= 0) {
					requests[index] = updated;
				}
			}) as IAgentRuntime["updatePairingRequest"],
			deletePairingRequest: (async (id: UUID) => {
				const index = requests.findIndex((r) => r.id === id);
				if (index >= 0) {
					requests.splice(index, 1);
				}
			}) as IAgentRuntime["deletePairingRequest"],
			getPairingAllowlists: (async (queries) =>
				queries.map((query) => ({
					channel: query.channel,
					agentId: query.agentId,
					entries: allowlist.filter(
						(e) => e.channel === query.channel && e.agentId === query.agentId,
					),
				}))) as IAgentRuntime["getPairingAllowlists"],
			createPairingAllowlistEntry: (async (entry: PairingAllowlistEntry) => {
				allowlist.push(entry);
				return entry.id;
			}) as IAgentRuntime["createPairingAllowlistEntry"],
			logger: {
				debug: noop,
				info: noop,
				warn: noop,
				error: noop,
			} as unknown as IAgentRuntime["logger"],
		});
		let service: PairingService;
		runtime.getService = (() =>
			service) as unknown as IAgentRuntime["getService"];
		service = new PairingService(runtime);
		return { runtime, service, requests, allowlist };
	}

	afterEach(() => {
		vi.useRealTimers();
	});

	it("replies once per sender, holds repeats, and re-arms after the TTL", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-10T00:00:00.000Z"));
		const { runtime } = makeHarness();

		const first = await checkPairingAllowed(runtime, {
			channel: "discord",
			senderId: "sender-a",
		});
		expect(first.allowed).toBe(false);
		expect(first.newRequest).toBe(true);
		expect(first.replyMessage).toContain(`Pairing code: ${first.pairingCode}`);

		// A repeat message from the same sender returns the existing request
		// without re-sending the unsolicited reply.
		const repeat = await checkPairingAllowed(runtime, {
			channel: "discord",
			senderId: "sender-a",
		});
		expect(repeat).toMatchObject({
			allowed: false,
			newRequest: false,
			pairingCode: first.pairingCode,
		});
		expect(repeat.replyMessage).toBeUndefined();

		// Once the request has expired, the sender is re-notified with a fresh code.
		vi.setSystemTime(new Date("2026-01-10T01:00:01.000Z"));
		const afterExpiry = await checkPairingAllowed(runtime, {
			channel: "discord",
			senderId: "sender-a",
		});
		expect(afterExpiry.newRequest).toBe(true);
		expect(afterExpiry.replyMessage).toContain(
			`Pairing code: ${afterExpiry.pairingCode}`,
		);
	});

	it("survives identity churn at the queue cap without re-replies or eviction", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-10T00:00:00.000Z"));
		const { runtime, requests } = makeHarness();

		// Fill the queue (maxPendingRequests defaults to 3).
		for (const senderId of ["sender-a", "sender-b", "sender-c"]) {
			const result = await checkPairingAllowed(runtime, {
				channel: "discord",
				senderId,
			});
			expect(result.replyMessage).toBeDefined();
		}
		expect(requests).toHaveLength(3);

		// A fourth cycling identity is held at the cap: no new request, no
		// reply, and the legitimate pending requests are not evicted.
		const overflow = await checkPairingAllowed(runtime, {
			channel: "discord",
			senderId: "sender-d",
		});
		expect(overflow).toMatchObject({ allowed: false, idLabel: "userId" });
		expect(overflow.pairingCode).toBeUndefined();
		expect(overflow.replyMessage).toBeUndefined();
		expect(requests.map((r) => r.senderId)).toEqual([
			"sender-a",
			"sender-b",
			"sender-c",
		]);

		// Repeat messages from senders already holding a request stay silent.
		for (const senderId of ["sender-a", "sender-b", "sender-c", "sender-d"]) {
			const result = await checkPairingAllowed(runtime, {
				channel: "discord",
				senderId,
			});
			expect(result.replyMessage).toBeUndefined();
		}
		expect(requests).toHaveLength(3);
	});

	it("keeps the legitimate approve-and-admit flow working", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-10T00:00:00.000Z"));
		const { runtime, service } = makeHarness();

		const pending = await checkPairingAllowed(runtime, {
			channel: "discord",
			senderId: "sender-legit",
		});
		expect(pending.replyMessage).toBeDefined();

		const approved = await service.approveCode({
			channel: "discord",
			code: pending.pairingCode ?? "",
		});
		expect(approved?.senderId).toBe("sender-legit");

		const admitted = await checkPairingAllowed(runtime, {
			channel: "discord",
			senderId: "sender-legit",
		});
		expect(admitted).toEqual({ allowed: true });

		// Approving freed the pending slot, so a new sender can pair again.
		const next = await checkPairingAllowed(runtime, {
			channel: "discord",
			senderId: "sender-next",
		});
		expect(next.newRequest).toBe(true);
		expect(next.replyMessage).toBeDefined();
	});
});

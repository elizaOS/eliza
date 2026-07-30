/**
 * State-composition tests for owner-exclusive providers, including explicit
 * onlyInclude requests and same-message cache reuse after audience changes.
 */
import { describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "../runtime";
import { attestDeliveryAudienceFromCanonicalRoom } from "../security";
import type { Character, Memory, Provider, UUID } from "../types";
import { ChannelType } from "../types";

const OWNER = "11111111-1111-1111-1111-111111111111" as UUID;
const ROOM = "22222222-2222-2222-2222-222222222222" as UUID;
const GUEST = "33333333-3333-3333-3333-333333333333" as UUID;

function message(runtime: AgentRuntime, id: UUID): Memory {
	return {
		id,
		entityId: OWNER,
		agentId: runtime.agentId,
		roomId: ROOM,
		content: { text: "private context", source: "discord" },
	};
}

function runtimeHarness(): {
	runtime: AgentRuntime;
	setParticipants: (participants: UUID[]) => void;
} {
	const runtime = new AgentRuntime({
		character: { name: "owner-private-provider-test" } as Character,
		settings: { ELIZA_ADMIN_ENTITY_ID: OWNER },
	});
	let participants = [OWNER, runtime.agentId];
	vi.spyOn(runtime, "getRoom").mockResolvedValue({
		id: ROOM,
		agentId: runtime.agentId,
		source: "discord",
		type: ChannelType.DM,
	});
	vi.spyOn(runtime, "getParticipantsForRoom").mockImplementation(async () => [
		...participants,
	]);
	return {
		runtime,
		setParticipants: (next) => {
			participants = next;
		},
	};
}

describe("composeState owner-exclusive providers", () => {
	it("does not let onlyInclude expose an unattested sensitive provider", async () => {
		const { runtime } = runtimeHarness();
		const get = vi.fn(async () => ({ text: "PRIVATE_PROVIDER_CANARY" }));
		const provider: Provider = {
			name: "PRIVATE",
			disclosureGate: { require: "owner_exclusive" },
			get,
		};
		runtime.registerProvider(provider);

		const state = await runtime.composeState(
			message(runtime, "44444444-4444-4444-4444-444444444444" as UUID),
			["PRIVATE"],
			true,
			true,
		);

		expect(get).not.toHaveBeenCalled();
		expect(state.text).not.toContain("PRIVATE_PROVIDER_CANARY");
		// Denial UX: the suppression is explicit in the composed state, so the
		// model can say the surface is unavailable instead of ignoring it.
		expect(state.text).toContain("Owner-private access notice");
		expect(state.text).toContain("missing_attestation");
	});

	it("never caches sensitive state and revalidates the same message", async () => {
		const { runtime, setParticipants } = runtimeHarness();
		const get = vi.fn(async () => ({ text: "PRIVATE_PROVIDER_CANARY" }));
		runtime.registerProvider({
			name: "PRIVATE",
			disclosureGate: { require: "owner_exclusive" },
			cacheStable: true,
			get,
		});
		const turn = message(
			runtime,
			"55555555-5555-5555-5555-555555555555" as UUID,
		);
		await attestDeliveryAudienceFromCanonicalRoom(runtime, turn);

		const first = await runtime.composeState(turn, ["PRIVATE"], true, true);
		expect(first.text).toContain("PRIVATE_PROVIDER_CANARY");
		expect(get).toHaveBeenCalledTimes(1);
		expect(runtime.stateCache.has(turn.id as string)).toBe(false);

		setParticipants([OWNER, runtime.agentId, GUEST]);
		const second = await runtime.composeState(turn, ["PRIVATE"], true, true);
		expect(second.text).not.toContain("PRIVATE_PROVIDER_CANARY");
		expect(get).toHaveBeenCalledTimes(1);
		expect(second.text).toContain("Owner-private access notice");
		expect(second.text).toContain("audience_changed");
	});
});

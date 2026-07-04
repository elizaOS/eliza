/**
 * #12087 Item 16: component-visibility filtering must decide trust from the
 * RESOLVED role (resolveEntityRole, which demotes a stale stored OWNER grant to
 * GUEST under a configured canonical owner and honors connector-admin
 * revocation), not the raw world.metadata.roles literal. resolveEntityRole is
 * stubbed here; the real isAdminRank is kept so the rank threshold is exercised.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Entity, IAgentRuntime, UUID, World } from "./types";

const { resolveEntityRoleMock } = vi.hoisted(() => ({
	resolveEntityRoleMock: vi.fn(),
}));
vi.mock("./roles", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./roles")>();
	return { ...actual, resolveEntityRole: resolveEntityRoleMock };
});

import { resolveTrustedComponentSourceIds } from "./entities";

const A = "00000000-0000-0000-0000-0000000000a1" as UUID;
const B = "00000000-0000-0000-0000-0000000000b1" as UUID;
const runtime = { agentId: "agent" } as unknown as IAgentRuntime;
// A carries a stored OWNER grant — the exact stale grant that must NOT be trusted
// once resolveEntityRole demotes it.
const world = {
	id: "00000000-0000-0000-0000-0000000000f1",
	metadata: { roles: { [A]: "OWNER" } },
} as unknown as World;
const components = [
	{ sourceEntityId: A },
	{ sourceEntityId: B },
] as NonNullable<Entity["components"]>;

describe("resolveTrustedComponentSourceIds (#12087 Item 16)", () => {
	beforeEach(() => {
		resolveEntityRoleMock.mockReset();
	});

	it("does NOT trust a stored OWNER that resolveEntityRole demotes", async () => {
		resolveEntityRoleMock.mockResolvedValue("GUEST"); // demoted despite stored OWNER
		const trusted = await resolveTrustedComponentSourceIds(
			runtime,
			world,
			components,
		);
		expect(trusted.has(A)).toBe(false);
	});

	it("trusts only source entities whose RESOLVED role is ADMIN or higher", async () => {
		resolveEntityRoleMock.mockImplementation(
			async (_rt: unknown, _w: unknown, _md: unknown, id: string) =>
				id === A ? "ADMIN" : "GUEST",
		);
		const trusted = await resolveTrustedComponentSourceIds(
			runtime,
			world,
			components,
		);
		expect(trusted.has(A)).toBe(true);
		expect(trusted.has(B)).toBe(false);
	});

	it("trusts nothing when there is no world", async () => {
		const trusted = await resolveTrustedComponentSourceIds(
			runtime,
			null,
			components,
		);
		expect(trusted.size).toBe(0);
		expect(resolveEntityRoleMock).not.toHaveBeenCalled();
	});
});

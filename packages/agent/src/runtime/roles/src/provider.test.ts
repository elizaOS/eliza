/**
 * Deterministic unit tests for rolesProvider.
 * Verifies role roster generation, complete UUID fallback (never truncated),
 * and best-effort name resolution for owners, admins, and users.
 */
import type { IAgentRuntime, Memory, State, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { rolesProvider } from "./provider.ts";

const ROOM_ID = "00000000-0000-0000-0000-000000000010" as UUID;
const WORLD_ID = "00000000-0000-0000-0000-000000000020" as UUID;
const OWNER_ID = "11111111-2222-3333-4444-555566667777" as UUID;
const ADMIN_ID = "88888888-9999-aaaa-bbbb-ccccddddeeee" as UUID;
const USER_ID = "33333333-4444-5555-6666-777788889999" as UUID;

function createMessage(entityId: UUID): Memory {
  return {
    id: "00000000-0000-0000-0000-000000000001" as UUID,
    roomId: ROOM_ID,
    entityId,
    content: { text: "check roles" },
  } as Memory;
}

describe("rolesProvider", () => {
  it("preserves complete entity UUIDs when display names are not configured", async () => {
    const runtime = {
      agentId: "99999999-9999-9999-9999-999999999999" as UUID,
      reportError: vi.fn(),
      getRoom: vi.fn(async () => ({ id: ROOM_ID, worldId: WORLD_ID })),
      getWorld: vi.fn(async () => ({
        id: WORLD_ID,
        metadata: {
          ownership: { ownerId: OWNER_ID },
          roles: {
            [OWNER_ID]: "OWNER",
            [ADMIN_ID]: "ADMIN",
            [USER_ID]: "USER",
          },
        },
      })),
      getEntityById: vi.fn(async (_id: UUID) => null),
    } as unknown as IAgentRuntime;

    const result = await rolesProvider.get(
      runtime,
      createMessage(OWNER_ID),
      {} as State,
    );

    expect(result.text).toContain(`Owners: ${OWNER_ID}`);
    expect(result.text).toContain(`Admins: ${ADMIN_ID}`);
    expect(result.text).toContain(`Users: ${USER_ID}`);
    expect(result.text).not.toMatch(/Owners:\s*11111111(?:\s|$|,)/);
    expect(result.text).not.toMatch(/Admins:\s*88888888(?:\s|$|,)/);
  });

  it("resolves display names when entity metadata is present", async () => {
    const runtime = {
      agentId: "99999999-9999-9999-9999-999999999999" as UUID,
      reportError: vi.fn(),
      getRoom: vi.fn(async () => ({ id: ROOM_ID, worldId: WORLD_ID })),
      getWorld: vi.fn(async () => ({
        id: WORLD_ID,
        metadata: {
          ownership: { ownerId: OWNER_ID },
          roles: {
            [OWNER_ID]: "OWNER",
            [ADMIN_ID]: "ADMIN",
          },
        },
      })),
      getEntityById: vi.fn(async (id: UUID) => {
        if (id === OWNER_ID) {
          return { id, names: ["Alice Owner"] };
        }
        if (id === ADMIN_ID) {
          return { id, metadata: { default: { name: "Bob Admin" } } };
        }
        return null;
      }),
    } as unknown as IAgentRuntime;

    const result = await rolesProvider.get(
      runtime,
      createMessage(OWNER_ID),
      {} as State,
    );

    expect(result.text).toContain("Owners: Alice Owner");
    expect(result.text).toContain("Admins: Bob Admin");
  });

  it("falls back to complete UUID when getEntityById throws during name resolution", async () => {
    const runtime = {
      agentId: "99999999-9999-9999-9999-999999999999" as UUID,
      reportError: vi.fn(),
      getRoom: vi.fn(async () => ({ id: ROOM_ID, worldId: WORLD_ID })),
      getWorld: vi.fn(async () => ({
        id: WORLD_ID,
        metadata: {
          ownership: { ownerId: OWNER_ID },
          roles: {
            [OWNER_ID]: "OWNER",
            [ADMIN_ID]: "ADMIN",
          },
        },
      })),
      getEntityById: vi.fn(async (id: UUID) => {
        if (id === OWNER_ID) {
          return { id, names: ["Alice Owner"] };
        }
        throw new Error("DB connection timeout");
      }),
    } as unknown as IAgentRuntime;

    const result = await rolesProvider.get(
      runtime,
      createMessage(OWNER_ID),
      {} as State,
    );

    expect(result.text).toContain("Owners: Alice Owner");
    expect(result.text).toContain(`Admins: ${ADMIN_ID}`);
    expect(result.text).not.toMatch(/Admins:\s*88888888(?:\s|$|,)/);
  });
});

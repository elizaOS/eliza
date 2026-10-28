import { beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  managed: undefined as
    | undefined
    | {
        owns: (grantId: unknown) => boolean;
        port: {
          preflight: ReturnType<typeof vi.fn>;
          execute: ReturnType<typeof vi.fn>;
        };
      },
  canonical: {
    preflight: vi.fn(async () => "canonical-preflight"),
    execute: vi.fn(async () => "canonical-receipt"),
  },
}));
vi.mock("@elizaos/plugin-calendar/mutations/managed", () => ({
  createManagedCalendarMutationPort: () => state.managed,
}));
vi.mock("@elizaos/plugin-calendar/mutations/port", () => ({
  createCalendarMutationPort: () => state.canonical,
}));
vi.mock("../service.js", () => ({ LifeOpsService: class {} }));

import { createLifeOpsCalendarMutationPort } from "./lifeops-port.js";

const managedGrant = `alpha-google:${"a".repeat(64)}`;
const runtime = { agentId: "agent" } as never;
const request = (grantId: string) =>
  ({ payload: { action: "cancel_event", grantId } }) as never;
beforeEach(() => {
  state.managed = undefined;
  state.canonical.preflight.mockClear();
  state.canonical.execute.mockClear();
});
it("routes managed owner grants to the managed host port, not the local provider path", async () => {
  const port = {
    preflight: vi.fn(async () => "managed-preflight"),
    execute: vi.fn(async () => "managed-receipt"),
  };
  state.managed = { owns: (id) => id === managedGrant, port };
  const lifeops = createLifeOpsCalendarMutationPort(runtime, {} as never);
  await expect(lifeops.preflight(request(managedGrant))).resolves.toBe(
    "managed-preflight",
  );
  await expect(
    lifeops.execute(request(managedGrant), {} as never),
  ).resolves.toBe("managed-receipt");
  await expect(lifeops.preflight(request("google-grant"))).resolves.toBe(
    "canonical-preflight",
  );
  expect(state.canonical.execute).not.toHaveBeenCalled();
});
it("keeps the canonical port when no managed host is configured", async () => {
  const lifeops = createLifeOpsCalendarMutationPort(runtime, {} as never);
  await lifeops.preflight(request(managedGrant));
  expect(state.canonical.preflight).toHaveBeenCalledTimes(1);
});

/** With plugin-maps stubbed out of a mobile bundle, the relay fails as unavailable. */
import { expect, it, vi } from "vitest";

vi.mock("@elizaos/plugin-maps/service", () => ({ MapsService: undefined }));
vi.mock("@elizaos/plugin-assistant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@elizaos/plugin-assistant")>()),
  DeviceActionService: class {
    async context() {
      return { scope: "scope" };
    }
  },
}));

it("reports the Maps service as unavailable, not a TypeError", async () => {
  const { DeviceActionError } = await import("@elizaos/plugin-assistant");
  const { handleMapsNavigationRelay } = await import(
    "../src/api/maps-navigation-relay.ts"
  );
  const id = "00000000-0000-4000-8000-000000000000";
  const call = handleMapsNavigationRelay(
    { getService: () => null } as never,
    {} as never,
    { phase: "open", conversationId: id, offerId: id },
  );
  await expect(call).rejects.toBeInstanceOf(DeviceActionError);
  await expect(call).rejects.toThrow("Maps service unavailable");
});

/**
 * End-to-end route contract for the FacewearView data source. The route handler
 * runs over FacewearService with realistically shaped XR and smartglasses
 * services, then pins the status DTO consumed by the view wrapper.
 */

import type { Route } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { facewearStatusRoute } from "../routes/device-config.ts";
import {
  FACEWEAR_SERVICE_TYPE,
  FacewearService,
} from "../services/facewear-service.ts";
import { SMARTGLASSES_SERVICE_NAME } from "../services/smartglasses-service.ts";
import { XR_SERVICE_TYPE } from "../services/xr-session-service.ts";

// The DTO the FacewearView wrapper parses (mirrors FacewearStatusResponse +
// ConnectedDevice in src/components/facewear-profiles.ts).
interface ConnectedDeviceDTO {
  id: string;
  kind: "xr" | "smartglasses";
  deviceType?: string;
}
interface StatusDTO {
  connected: boolean;
  devices: ConnectedDeviceDTO[];
}

function makeRuntimeWith(opts: {
  xrConnections?: Array<{ id: string; deviceType: string }>;
  smartglassesConnected?: boolean;
}) {
  const xrService = {
    getConnections: () => opts.xrConnections ?? [],
  };
  const smartglassesService = {
    getStatus: () => ({ connected: opts.smartglassesConnected ?? false }),
  };
  // The runtime resolves the FacewearService (which itself resolves the XR +
  // smartglasses services through the same getService).
  const runtime = {
    getService: vi.fn((type: string) => {
      if (type === XR_SERVICE_TYPE) return xrService;
      if (type === SMARTGLASSES_SERVICE_NAME) return smartglassesService;
      if (type === FACEWEAR_SERVICE_TYPE) {
        return new FacewearService(runtime as never);
      }
      return undefined;
    }),
  };
  return runtime;
}

async function runStatusRoute(runtime: unknown): Promise<{
  status: number;
  contentType?: string;
  dto: StatusDTO;
}> {
  const route = facewearStatusRoute as Route;
  const result = await route.routeHandler?.({ runtime } as never);
  if (!result) throw new Error("route returned no result");
  return {
    status: result.status ?? 0,
    contentType: (result.headers as Record<string, string> | undefined)?.[
      "Content-Type"
    ],
    dto: JSON.parse(result.body as string) as StatusDTO,
  };
}

describe("facewearStatusRoute -> FacewearView DTO contract", () => {
  it("returns connected:false with an empty devices array when nothing is connected", async () => {
    const { status, contentType, dto } = await runStatusRoute(
      makeRuntimeWith({}),
    );
    expect(status).toBe(200);
    expect(contentType).toBe("application/json");
    expect(dto).toEqual({ connected: false, devices: [] });
  });

  it("emits one xr device per XR connection with id + deviceType the view renders", async () => {
    const { dto } = await runStatusRoute(
      makeRuntimeWith({
        xrConnections: [
          { id: "quest-1", deviceType: "meta-quest" },
          { id: "avp-1", deviceType: "apple-vision-pro" },
        ],
      }),
    );
    expect(dto.connected).toBe(true);
    expect(dto.devices).toEqual([
      { id: "quest-1", kind: "xr", deviceType: "meta-quest" },
      { id: "avp-1", kind: "xr", deviceType: "apple-vision-pro" },
    ]);
    // Every device matches the ConnectedDevice contract the view consumes.
    for (const d of dto.devices) {
      expect(typeof d.id).toBe("string");
      expect(["xr", "smartglasses"]).toContain(d.kind);
    }
  });

  it("emits a smartglasses device (kind only, no deviceType) when the headset is connected", async () => {
    const { dto } = await runStatusRoute(
      makeRuntimeWith({ smartglassesConnected: true }),
    );
    expect(dto.connected).toBe(true);
    expect(dto.devices).toEqual([{ id: "smartglasses", kind: "smartglasses" }]);
    // The view's even-realities card derivation relies on kind==="smartglasses"
    // with deviceType absent — assert that exact shape.
    expect(dto.devices[0].deviceType).toBeUndefined();
  });

  it("combines XR + smartglasses devices in one response", async () => {
    const { dto } = await runStatusRoute(
      makeRuntimeWith({
        xrConnections: [{ id: "xreal-1", deviceType: "xreal" }],
        smartglassesConnected: true,
      }),
    );
    expect(dto.connected).toBe(true);
    expect(dto.devices).toEqual([
      { id: "xreal-1", kind: "xr", deviceType: "xreal" },
      { id: "smartglasses", kind: "smartglasses" },
    ]);
  });

  it("returns an empty list when no FacewearService is registered", async () => {
    const runtime = { getService: vi.fn(() => undefined) };
    const { dto } = await runStatusRoute(runtime);
    expect(dto).toEqual({ connected: false, devices: [] });
  });
});

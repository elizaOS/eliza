import type { Route } from "@elizaos/core";
import {
  getAllDeviceProfiles,
  getDeviceProfile,
  type FacewearDeviceType,
} from "../devices/registry.ts";
import { FACEWEAR_SERVICE_TYPE, FacewearService } from "../services/facewear-service.ts";

export const facewearDevicesRoute: Route = {
  path: "/api/facewear/devices",
  type: "GET",
  routeHandler: async (_ctx) => ({
    status: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ devices: getAllDeviceProfiles() }),
  }),
};

export const facewearDeviceRoute: Route = {
  path: "/api/facewear/devices/:id",
  type: "GET",
  routeHandler: async (ctx) => {
    const id = (ctx.params as Record<string, string>).id as FacewearDeviceType;
    try {
      const profile = getDeviceProfile(id);
      return {
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(profile),
      };
    } catch {
      return { status: 404, body: JSON.stringify({ error: "Device not found" }) };
    }
  },
};

export const facewearStatusRoute: Route = {
  path: "/api/facewear/status",
  type: "GET",
  routeHandler: async (ctx) => {
    const svc = ctx.runtime?.getService<FacewearService>(FACEWEAR_SERVICE_TYPE);
    const devices = svc?.getConnectedDevices() ?? [];
    return {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connected: devices.length > 0, devices }),
    };
  },
};

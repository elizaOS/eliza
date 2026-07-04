/**
 * Facewear device routes expose supported device profiles and active connection
 * status to the settings UI.
 */
import type { Route } from "@elizaos/core";
import {
  getAllDeviceProfiles,
  getDeviceProfile,
  isFacewearDeviceType,
} from "../devices/registry.ts";
import {
  FACEWEAR_SERVICE_TYPE,
  type FacewearService,
} from "../services/facewear-service.ts";

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
    const id = (ctx.params as Record<string, string>).id;
    const profile = isFacewearDeviceType(id) ? getDeviceProfile(id) : undefined;
    if (!profile) {
      return {
        status: 404,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Device not found" }),
      };
    }
    return {
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(profile),
    };
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

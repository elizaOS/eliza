/**
 * Exposes Android-only device controls to the agent through the existing
 * view-interact transport without adding a visible launcher surface.
 */

import { Capacitor } from "@capacitor/core";
import {
  getSystemPlugin,
  type SystemPluginLike,
} from "../../bridge/native-plugins";
import { registerViewInteractHandler } from "./view-interact-registry";

type FlashlightPlugin = Pick<Required<SystemPluginLike>, "setFlashlight">;

export function createDeviceControlInteractHandler(system: FlashlightPlugin) {
  return async (
    capability: string,
    params: Record<string, unknown> | undefined,
  ): Promise<unknown> => {
    if (capability !== "set-flashlight") {
      throw new Error(`Unsupported device-control capability: ${capability}`);
    }
    if (typeof params?.enabled !== "boolean") {
      throw new Error("set-flashlight requires boolean parameter enabled");
    }

    const result = await system.setFlashlight({ enabled: params.enabled });
    if (!result.available) {
      throw new Error("Flashlight is unavailable on this device");
    }
    return {
      success: true,
      text: `Turned the flashlight ${result.enabled ? "on" : "off"}.`,
      data: result,
    };
  };
}

export function registerDeviceControlInteractHandler(): () => void {
  if (Capacitor.getPlatform() !== "android") return () => {};

  const system = getSystemPlugin();
  if (typeof system.setFlashlight !== "function") return () => {};
  return registerViewInteractHandler(
    "device-control",
    "gui",
    createDeviceControlInteractHandler(system as FlashlightPlugin),
  );
}

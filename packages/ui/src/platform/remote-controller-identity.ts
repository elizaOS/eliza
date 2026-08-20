/** Native, device-bound public identity used when consuming Cloud pairing codes. */
import { Capacitor } from "@capacitor/core";
import type { RemoteControllerPublicIdentity } from "@elizaos/shared";
import { invokeDesktopBridgeRequest } from "../bridge/electrobun-rpc";
import { getNativePlugin } from "../bridge/native-plugins";

const DEVICE_ID_KEY = "eliza.remote-controller.device-id.v1";

interface NativeControllerIdentityPlugin extends Record<string, unknown> {
  getOrCreateControllerIdentity?: (input: { deviceId: string }) => Promise<{
    deviceId: string;
    keyId: string;
    hardwareBacked: boolean;
    publicKeyJwk: JsonWebKey;
    signingPublicKeyJwk?: JsonWebKey;
    encryptionPublicKeyJwk?: JsonWebKey;
  }>;
}

function stablePublicDeviceId(): string {
  const stored = globalThis.localStorage?.getItem(DEVICE_ID_KEY)?.trim();
  if (stored) return stored;
  const created = crypto.randomUUID();
  globalThis.localStorage?.setItem(DEVICE_ID_KEY, created);
  return created;
}

function desktopPlatform(): "macos" | "windows" | "linux" {
  const platform = navigator.platform.toLowerCase();
  if (platform.includes("win")) return "windows";
  if (platform.includes("linux")) return "linux";
  return "macos";
}

function displayName(platform: string): string {
  if (platform === "ios") return "My iPhone";
  if (platform === "windows") return "My Windows PC";
  if (platform === "linux") return "My Linux computer";
  return "My Mac";
}

export async function getOrCreateControllerPublicIdentity(): Promise<RemoteControllerPublicIdentity> {
  const deviceId = stablePublicDeviceId();
  if (Capacitor.getPlatform() === "ios") {
    const native =
      getNativePlugin<NativeControllerIdentityPlugin>("ElizaIntent");
    if (typeof native.getOrCreateControllerIdentity !== "function") {
      throw new Error("Secure device identity is unavailable on this iPhone.");
    }
    const identity = await native.getOrCreateControllerIdentity({ deviceId });
    return {
      version: 1,
      deviceId: identity.deviceId,
      keyId: identity.keyId,
      displayName: displayName("ios"),
      platform: "ios",
      signingPublicKeyJwk:
        identity.signingPublicKeyJwk ?? identity.publicKeyJwk,
      encryptionPublicKeyJwk:
        identity.encryptionPublicKeyJwk ?? identity.publicKeyJwk,
      createdAt: Date.now(),
    };
  }

  const platform = desktopPlatform();
  const identity =
    await invokeDesktopBridgeRequest<RemoteControllerPublicIdentity>({
      rpcMethod: "desktopGetOrCreateControllerIdentity",
      ipcChannel: "desktop:getOrCreateControllerIdentity",
      params: { deviceId, displayName: displayName(platform), platform },
    });
  if (!identity) {
    throw new Error(
      "Device pairing requires the Eliza iPhone or desktop app so private keys stay in secure storage.",
    );
  }
  return identity;
}

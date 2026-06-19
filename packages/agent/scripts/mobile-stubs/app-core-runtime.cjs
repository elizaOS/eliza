"use strict";

// Mobile agent bundle shim for @elizaos/app-core.
//
// The app-core package root is a broad desktop/node barrel that re-exports UI,
// registry, payment, training, and server modules. The on-device agent runtime
// only imports a small boot-hook surface from it, and most of that surface is
// disabled on mobile before use. Keeping this shim bundle-only prevents the iOS
// full-Bun payload from parsing the entire desktop app stack at startup.

const noopAsync = async () => undefined;

const vault = {
  has: async () => false,
  reveal: async () => "",
  set: noopAsync,
  remove: noopAsync,
};

function resolveRuntimeMode(config) {
  const target =
    config && typeof config === "object" ? config.deploymentTarget : null;
  const runtime =
    target && typeof target === "object" && typeof target.runtime === "string"
      ? target.runtime
      : "local";
  if (runtime === "remote") {
    const remoteApiBase =
      typeof target.remoteApiBase === "string" ? target.remoteApiBase : null;
    return {
      mode: "remote",
      deploymentTarget: target,
      remoteApiBase,
      remoteApiBaseError: remoteApiBase ? null : "remoteApiBase is required",
      remoteAccessToken:
        typeof target.remoteAccessToken === "string"
          ? target.remoteAccessToken
          : null,
    };
  }
  if (runtime === "cloud") {
    return {
      mode: "cloud",
      deploymentTarget: target,
      remoteApiBase: null,
      remoteApiBaseError: null,
      remoteAccessToken: null,
    };
  }
  const cloud = config && typeof config === "object" ? config.cloud : null;
  return {
    mode:
      cloud && typeof cloud === "object" && cloud.enabled === false
        ? "local-only"
        : "local",
    deploymentTarget: target,
    remoteApiBase: null,
    remoteApiBaseError: null,
    remoteAccessToken: null,
  };
}

function getBuildVariant() {
  return process.env.ELIZA_BUILD_VARIANT === "store" ? "store" : "direct";
}

module.exports = {
  hydrateWalletKeysFromNodePlatformSecureStore: noopAsync,
  runVaultBootstrap: async () => ({ migrated: 0, failed: [] }),
  sharedVault: () => vault,
  getDefaultAccountPool: () => null,
  applyAccountPoolApiCredentials: noopAsync,
  startAccountPoolKeepAlive: () => undefined,
  ensureLocalInferenceHandler: noopAsync,
  resolveRuntimeMode,
  getBuildVariant,
  isStoreBuild: () => getBuildVariant() === "store",
};

/** Owns ios build policy using the shared build context and existing platform contracts. */
import path from "node:path";
import process from "node:process";
import { appDir } from "../context.mjs";
import { firstExisting } from "../toolchain.mjs";
import { isIosAppStoreBuild, shouldIncludeIosLlama } from "./policy.mjs";

export function shouldRunIosPodInstall(syncedFiles = []) {
  return syncedFiles.includes(path.join("App", "Podfile"));
}

export function resolveIosBuildTarget({
  env = process.env,
  appDirValue = appDir,
} = {}) {
  const explicitDestination = env.ELIZA_IOS_BUILD_DESTINATION;
  const explicitSdk = env.ELIZA_IOS_BUILD_SDK;

  if (explicitDestination || explicitSdk) {
    return {
      destination: explicitDestination ?? "generic/platform=iOS Simulator",
      sdk: explicitSdk ?? "iphonesimulator",
      reason: "explicit environment override",
    };
  }

  if (isIosAppStoreBuild(env)) {
    return {
      destination: "generic/platform=iOS",
      sdk: "iphoneos",
      reason: "App Store device build",
    };
  }

  const includeDeviceOnlyLlama = shouldIncludeIosLlama(env);
  const llamaCppFramework = firstExisting([
    path.join(
      appDirValue,
      "node_modules",
      "llama-cpp-capacitor",
      "ios",
      "Frameworks",
      "LlamaCpp.framework",
      "LlamaCpp",
    ),
    path.join(
      appDirValue,
      "node_modules",
      "llama-cpp-capacitor",
      "ios",
      "Frameworks",
      "llama-cpp.framework",
      "llama-cpp",
    ),
  ]);

  if (includeDeviceOnlyLlama && llamaCppFramework) {
    return {
      destination: "generic/platform=iOS",
      sdk: "iphoneos",
      reason: "explicit device llama.cpp framework build",
    };
  }

  return {
    destination: "generic/platform=iOS Simulator",
    sdk: "iphonesimulator",
    reason: "default cloud simulator build",
  };
}

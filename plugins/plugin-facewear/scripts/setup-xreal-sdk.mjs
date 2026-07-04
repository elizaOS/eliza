#!/usr/bin/env node
/**
 * XREAL SDK 3.0.0 setup helper
 * The XREAL SDK requires a manual download from https://developer.xreal.com/
 * This script checks if it's in place and prints instructions.
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const libsDir = resolve(pluginRoot, "native/android/xreal/app/libs");

console.log("XREAL SDK 3.0.0 Setup");
console.log("======================");
console.log("");
console.log(
	"The XREAL SDK requires manual download from https://developer.xreal.com/",
);
console.log("");
console.log("Steps:");
console.log("1. Register at https://developer.xreal.com/");
console.log("2. Download XREAL SDK 3.0.0 (nrsdk3.aar)");
console.log(`3. Place in: ${libsDir}/`);
console.log("4. Open native/android/xreal/ in Android Studio");
console.log(
	"5. Replace Camera2Service with NRCameraRig (see XrealBridgeJs.kt)",
);
console.log("6. Build: ./gradlew assembleDebug");
console.log("");
console.log(
	"XREAL One Pro / Air 3 require SDK 3.0.0+ for spatial computing features.",
);
console.log("XReal Air 2 Ultra can use SDK 2.x for basic WebView support.");

if (existsSync(libsDir)) {
	const hasAar = ["nrsdk3.aar", "xreal-sdk.aar", "nrsdk.aar"].some((f) =>
		existsSync(resolve(libsDir, f)),
	);
	if (hasAar) {
		console.log("\n✓ XREAL SDK AAR found in app/libs/");
	} else {
		console.log("\n⚠ XREAL SDK AAR not found — manual download required");
	}
}

#!/usr/bin/env node
/**
 * visionOS / Apple Vision Pro setup helper
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { platform } from "node:os";

console.log("Apple Vision Pro / visionOS Setup");
console.log("===================================");
console.log("");

if (platform() !== "darwin") {
	console.log(
		"⚠ This setup requires macOS + Xcode. Skipping on this platform.",
	);
	process.exit(0);
}

// Check Xcode
try {
	const ver = execSync("xcodebuild -version 2>&1").toString().split("\n")[0];
	console.log(`✓ ${ver}`);
	const match = ver.match(/Xcode (\d+)/);
	if (match && parseInt(match[1], 10) < 16) {
		console.log("⚠ Xcode 16+ required for visionOS 2.4 SDK");
		console.log("  Update: App Store → Xcode");
	}
} catch {
	console.log("⚠ Xcode not found");
	console.log("  Install: https://developer.apple.com/xcode/");
}

// Check simulator
const simPath =
	"/Library/Developer/CoreSimulator/Profiles/Runtimes/visionOS.simruntime";
if (existsSync(simPath)) {
	console.log("✓ Apple Vision Pro Simulator installed");
} else {
	console.log("⚠ Vision Pro Simulator not found");
	console.log("  In Xcode: Platforms & Simulators → visionOS → Download");
}

console.log("\nManual Steps:");
console.log("1. Apple Developer account: https://developer.apple.com/");
console.log(
	"2. Enable Vision Pro in Devices: Settings → Privacy → Developer Mode",
);
console.log("3. Open native/visionos/ElizaFacewear.xcodeproj in Xcode");
console.log("4. Set your Team ID in project settings");
console.log("5. Run on Vision Pro Simulator or physical device");
console.log("");
console.log("Architecture Notes:");
console.log(
	"- App connects to elizaOS agent via WebSocket (same as Quest/XReal)",
);
console.log("- WebXR in Safari/WKWebView (visionOS 1.1+)");
console.log("- RealityKit renders 3D panels in immersive space");
console.log("- Persona camera + mic via AVCaptureSession");

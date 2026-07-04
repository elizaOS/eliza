#!/usr/bin/env node
/**
 * Smartglasses completion gate: combines the software-readiness check with the
 * freshness of the latest hardware-smoke report and prints a JSON summary,
 * exiting non-zero unless both pass. The hardware report path and its max age
 * come from CLI args or SMARTGLASSES_REPORT_PATH / SMARTGLASSES_COMPLETION_MAX_AGE_MS.
 * `--self-test` exercises the gate logic against synthetic inputs.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const defaultReportPath = "/tmp/smartglasses-hardware-report-latest.json";
const maxAgeMs = Number(
  process.env.SMARTGLASSES_COMPLETION_MAX_AGE_MS ?? 600000,
);
const reportPath =
  process.argv.find((arg) => !arg.startsWith("--") && arg.endsWith(".json")) ??
  process.env.SMARTGLASSES_REPORT_PATH ??
  defaultReportPath;

if (process.argv.includes("--self-test")) {
  runSelfTest();
  process.exit(0);
}

const softwareFailures = softwareGateFailures();
const hardware = hardwareGateSummary(reportPath, maxAgeMs);
const ok = softwareFailures.length === 0 && hardware.ok;

const summary = {
  ok,
  softwareReady: softwareFailures.length === 0,
  softwareFailures,
  hardware,
};

const output = JSON.stringify(summary, null, 2);
if (ok) {
  console.log(output);
  process.exit(0);
}

console.error(output);
process.exit(1);

function softwareGateFailures() {
  const failures = [];
  for (const relPath of [
    "plugins/plugin-facewear/package.json",
    "plugins/plugin-facewear/src/services/smartglasses-service.ts",
    "plugins/plugin-facewear/src/protocol/smartglasses.ts",
    "plugins/plugin-facewear/src/ui/SmartglassesView.tsx",
    "plugins/plugin-facewear/src/register.ts",
    "plugins/plugin-facewear/src/index.ts",
    "plugins/plugin-facewear/src/routes/views.ts",
    "plugins/plugin-facewear/src/actions/display-text.ts",
    "plugins/plugin-facewear/src/actions/microphone.ts",
    "plugins/plugin-facewear/src/actions/facewear-status.ts",
    "plugins/plugin-facewear/src/actions/facewear-control.ts",
    "plugins/plugin-facewear/src/actions/facewear-connect.ts",
    "plugins/plugin-facewear/src/providers/smartglasses-status.ts",
    "plugins/plugin-facewear/src/status-format.ts",
    "plugins/plugin-facewear/src/__tests__/smartglasses-basic-actions.test.ts",
    "plugins/plugin-facewear/src/__tests__/protocol-smartglasses.test.ts",
    "plugins/plugin-facewear/src/__tests__/facewear-service.test.ts",
    "plugins/plugin-facewear/src/__tests__/smartglasses-view-report.test.ts",
    "plugins/plugin-facewear/src/__tests__/xr-smartglasses-bridge.test.ts",
    "plugins/plugin-facewear/src/__tests__/smartglasses-control-action.test.ts",
    "plugins/plugin-facewear/src/transport/web-bluetooth.ts",
    "plugins/plugin-facewear/src/transport/noble.ts",
    "plugins/plugin-facewear/registry-entry.json",
    "packages/app/src/plugin-registrations.ts",
    "plugins/plugin-facewear/native/android/even-realities/app/src/main/java/com/elizaos/facewear/evenrealities/G1BleService.kt",
    "plugins/plugin-facewear/native/android/even-realities/app/src/main/java/com/elizaos/facewear/evenrealities/AgentBridgeService.kt",
    "packages/examples/smartglasses/package.json",
    "packages/examples/smartglasses/package-smoke.ts",
    "packages/examples/smartglasses/eliza-runtime-smoke.ts",
    "packages/examples/smartglasses/hardware-doctor.mjs",
    "packages/examples/smartglasses/hardware-evidence.ts",
    "packages/examples/smartglasses/hardware-local-bluetooth.ts",
    "packages/examples/smartglasses/validate-hardware-report.ts",
    "packages/examples/smartglasses/bleak-hardware-smoke.py",
    "packages/examples/smartglasses/noble-hardware-smoke.ts",
    "scripts/check-even-research-audit.mjs",
    "plugins/plugin-facewear/docs/smartglasses.md",
    "plugins/plugin-facewear/docs/smartglasses-upstream-audit.md",
    "plugins/plugin-facewear/docs/smartglasses-completion-audit.md",
  ]) {
    if (!existsSync(resolve(repoRoot, relPath)))
      failures.push(`${relPath}: missing`);
  }

  const examplePackage = readJson(
    "packages/examples/smartglasses/package.json",
  );
  const scripts = examplePackage?.scripts ?? {};
  const rootPackage = readJson("package.json");
  const rootScripts = rootPackage?.scripts ?? {};
  const rootSoftwareVerifyScript = String(
    rootScripts["audit:smartglasses-software"] ?? "",
  );
  if (
    !rootSoftwareVerifyScript.includes(
      "scripts/verify-smartglasses-software.mjs",
    )
  ) {
    failures.push(
      "package.json: missing audit:smartglasses-software root verification script",
    );
  }
  for (const scriptName of [
    "hardware:doctor",
    "hardware:status-latest",
    "hardware:validate-latest",
    "hardware:prove:bleak",
    "hardware:prove:bleak:watch",
    "hardware:prove:noble",
    "hardware:prove:noble:watch",
    "dev:hardware",
    "dev:simulator",
    "simulator",
    "smoke:simulator",
  ]) {
    if (!scripts[scriptName]) {
      failures.push(
        `packages/examples/smartglasses/package.json: missing script ${scriptName}`,
      );
    }
  }
  failures.push(
    ...sourceTokenFailures("scripts/verify-smartglasses-software.mjs", [
      "plugins/plugin-facewear",
      "lint",
      "typecheck",
      "test",
      "verify:app",
      "packages/examples/smartglasses",
      "verify:software",
      "scripts/check-even-research-audit.mjs",
      '"--self-test"',
      "scripts/check-smartglasses-completion-gate.mjs",
      "--self-test",
    ]),
  );
  failures.push(
    ...sourceTokenFailures("scripts/check-smartglasses-completion-gate.mjs", [
      "inspectBluetoothPreflight",
      "parseSystemProfilerBluetooth",
      "pairedG1Devices",
      "pairedWholeHeadset",
      "bluetoothAdapter",
      "bluetoothPreflightSource",
    ]),
  );
  failures.push(
    ...sourceTokenFailures("scripts/check-even-research-audit.mjs", [
      "fabioglimb/even-toolkit",
      "BxNxM/even-dev",
      "emingenc/even_glasses",
      "binarythinktank/eveng1_python_sdk",
      "meyskens/fahrplan",
      "nickustinov/weather-even-g2",
      "jappyjan/even-realities",
      "emingenc/g1_flutter_blue_plus",
      "nickustinov/tesla-even-g2",
      "galfaroth/awesome-even-realities-g1",
      "even-realities/EvenDemoApp",
      "Mentra-Community/MentraOS",
      "src/providers/smartglasses-status.ts",
      "docs/smartglasses-upstream-audit.md",
      "stale provider path",
      "stale link",
    ]),
  );
  for (const scriptName of [
    "verify:software",
    "test:protocol",
    "hardware:doctor",
    "hardware:validate-latest",
    "hardware:test-doctor",
    "hardware:prove:bleak",
    "hardware:prove:bleak:watch",
    "smoke:package",
    "smoke:runtime",
    "smoke:simulator",
  ]) {
    if (!scripts[scriptName]) {
      failures.push(
        `packages/examples/smartglasses/package.json: missing script ${scriptName}`,
      );
    }
  }
  if (
    examplePackage?.dependencies?.["@elizaos/plugin-facewear"] !== "workspace:*"
  ) {
    failures.push(
      "packages/examples/smartglasses/package.json: missing @elizaos/plugin-facewear workspace dependency",
    );
  }
  const verifySoftwareScript = String(scripts["verify:software"] ?? "");
  for (const requiredStep of [
    "lint",
    "test",
    "test:protocol",
    "hardware:test-bleak-parser",
    "hardware:test-doctor",
    "typecheck",
    "smoke:package",
    "smoke:runtime",
    "smoke:simulator",
  ]) {
    if (!verifySoftwareScript.includes(requiredStep)) {
      failures.push(
        `packages/examples/smartglasses/package.json: verify:software must run ${requiredStep}`,
      );
    }
  }
  const typecheckScript = String(scripts.typecheck ?? "");
  if (
    !typecheckScript.includes("run-turbo.mjs run build") ||
    !typecheckScript.includes("--filter=@elizaos/plugin-facewear") ||
    !typecheckScript.includes("hardware-local-bluetooth.ts")
  ) {
    failures.push(
      "packages/examples/smartglasses/package.json: typecheck must build Facewear dependencies before tsc and include hardware-local-bluetooth.ts",
    );
  }

  const facewearPackage = readJson("plugins/plugin-facewear/package.json");
  const facewearScripts = facewearPackage?.scripts ?? {};
  for (const scriptName of [
    "lint",
    "typecheck",
    "test",
    "build",
    "build:views",
    "verify:app",
    "emulator:build",
  ]) {
    if (!facewearScripts[scriptName]) {
      failures.push(
        `plugins/plugin-facewear/package.json: missing script ${scriptName}`,
      );
    }
  }
  if (!String(facewearScripts.test ?? "").includes("build:views")) {
    failures.push(
      "plugins/plugin-facewear/package.json: test must build views before vitest",
    );
  }
  if (!String(facewearScripts.test ?? "").includes("emulator:build")) {
    failures.push(
      "plugins/plugin-facewear/package.json: test must build emulator before vitest",
    );
  }
  const buildScript = String(facewearScripts.build ?? "");
  const buildJsScript = String(facewearScripts["build:js"] ?? "");
  const buildViewsScript = String(facewearScripts["build:views"] ?? "");
  if (
    !buildScript.includes("build:js") ||
    !buildScript.includes("build:views") ||
    !buildScript.includes("build:types")
  ) {
    failures.push(
      "plugins/plugin-facewear/package.json: build must run js, views, and types",
    );
  }
  if (
    !buildJsScript.includes("tsup --config ../tsup.plugin-packages.shared.ts")
  ) {
    failures.push(
      "plugins/plugin-facewear/package.json: build:js must use the workspace tsup binary",
    );
  }
  if (
    !buildViewsScript.includes("vite@7.2.7") ||
    !buildViewsScript.includes("vite build --config vite.config.views.ts")
  ) {
    failures.push(
      "plugins/plugin-facewear/package.json: build:views must use the stable Vite 7 view build",
    );
  }

  for (const staleFailure of staleSmartglassesReferenceFailures()) {
    failures.push(staleFailure);
  }

  failures.push(
    ...sourceTokenFailures(
      "plugins/plugin-facewear/src/services/smartglasses-service.ts",
      [
        "async displayText",
        "async displayRsvpText",
        "sendConnectionReady",
        "this.transport.onAudio",
        "handleAudioChunk",
        "microphoneActionForInteractionEvent",
        'microphoneAction === "enable"',
        "setMicrophoneEnabled(enabled",
      ],
    ),
  );
  failures.push(
    ...sourceTokenFailures(
      "plugins/plugin-facewear/src/protocol/smartglasses.ts",
      [
        "OpenMic = 0x0e",
        "encodeTextPackets",
        "paginateDisplayText",
        "parseG1Notification",
        "microphoneActionForInteractionEvent",
        "single_tap",
        "double_tap",
        "stop_ai_recording",
      ],
    ),
  );
  failures.push(
    ...sourceTokenFailures(
      "plugins/plugin-facewear/src/ui/SmartglassesView.tsx",
      [
        "missingViewEvidence",
        "buildViewDisplayPackets",
        "displaySeqRef",
        "scanDiagnosis",
        "physicalBlocker",
        "onAudio",
        "callWifiBridge",
        "Guide",
      ],
    ),
  );
  failures.push(
    ...sourceTokenFailures(
      "plugins/plugin-facewear/src/ui/SmartglassesView.helpers.ts",
      ["viewStreamingStatus", "does not support Wi-Fi command"],
    ),
  );
  failures.push(
    ...sourceTokenFailures(
      "plugins/plugin-facewear/docs/smartglasses-completion-audit.md",
      [
        "bun run audit:smartglasses-software",
        "workspace `tsup` binary",
        "stable `vite@7.2.7`",
        "20 plugin test files / 185 tests",
        "bun run --cwd packages/examples/smartglasses verify:software",
        "software gate includes `hardware:test-doctor`",
        "scanned 34,567 files",
        "completion gate now also checks critical lockfile/manifest paths plus the stable Facewear build scripts",
        "Blocked on physical headset advertising/availability",
      ],
    ),
  );
  failures.push(
    ...sourceTokenFailures("plugins/plugin-facewear/src/register.ts", [
      'id: "smartglasses"',
      'path: "/apps/smartglasses"',
      "loadSmartglassesView",
      "@elizaos/plugin-facewear",
    ]),
  );
  failures.push(
    ...sourceTokenFailures("plugins/plugin-facewear/src/index.ts", [
      'path: "/apps/smartglasses"',
      'componentExport: "SmartglassesView"',
      "smartglassesStatusProvider",
      "SmartglassesService",
      "smartglassesPlugin = facewearPlugin",
    ]),
  );
  failures.push(
    ...sourceTokenFailures("plugins/plugin-facewear/src/routes/views.ts", [
      'path: "/xr/views"',
      "listViews(",
      'viewType: "xr"',
    ]),
  );
  failures.push(
    ...sourceTokenFailures(
      "plugins/plugin-facewear/src/actions/display-text.ts",
      [
        'name: "SMARTGLASSES_DISPLAY_TEXT"',
        "displayParamsFromMessage",
        "service.displayText",
        "Smartglasses display command failed",
        "displayFacewearTextAction",
      ],
    ),
  );
  failures.push(
    ...sourceTokenFailures(
      "plugins/plugin-facewear/src/actions/microphone.ts",
      [
        'name: "SMARTGLASSES_MICROPHONE"',
        "enabledFromMessage",
        "service.setMicrophoneEnabled",
        "Smartglasses microphone command failed",
        "facewearMicrophoneAction",
      ],
    ),
  );
  failures.push(
    ...sourceTokenFailures(
      "plugins/plugin-facewear/src/actions/facewear-status.ts",
      [
        'name: "SMARTGLASSES_STATUS"',
        "service.getStatus()",
        "facewearStatusAction",
      ],
    ),
  );
  failures.push(
    ...sourceTokenFailures(
      "plugins/plugin-facewear/src/actions/facewear-control.ts",
      [
        'name: "SMARTGLASSES_CONTROL"',
        "scanWifi",
        "configureWifi",
        "requestVoiceNoteAudio",
        "setDashboardPosition",
        "operationResult = await service.sendAppWhitelist",
        "operationResult = await service.sendG1Setup",
        "operationResult = await service.sendNavigationPrimaryImage",
        "operationResult = await service.sendNavigationSecondaryImage",
        "operationResult = await service.requestVoiceNoteAudio",
        "operationResult = await service.deleteVoiceNoteAudio",
        "operationResult = await service.sendNotification",
        "operationResult = await service.sendBmpImage",
        "Smartglasses $" + "{op} command failed",
        "facewearControlAction",
      ],
    ),
  );
  failures.push(
    ...sourceTokenFailures(
      "plugins/plugin-facewear/src/actions/facewear-connect.ts",
      ['name: "FACEWEAR_CONNECT"', "FacewearService", "connect"],
    ),
  );
  failures.push(
    ...sourceTokenFailures(
      "plugins/plugin-facewear/src/providers/smartglasses-status.ts",
      [
        "setupSummaryForStatus",
        "formatConnectedLensesForProvider",
        "wholeHeadset=",
        "wearingReady=",
        "physicalBlocker=",
        "audioChunks=",
        "wifiStatus=",
        "lastSerialNumber",
      ],
    ),
  );
  failures.push(
    ...sourceTokenFailures("plugins/plugin-facewear/src/status-format.ts", [
      "setupSummaryForStatus",
      "wholeHeadsetConnected",
      "wearingReady",
      "physicalBlocker",
      "headset_not_found",
      "partial_headset",
      "in_charging_base",
      "wearing_state_missing",
      "setupHintForStatus",
    ]),
  );
  failures.push(
    ...sourceTokenFailures(
      "plugins/plugin-facewear/src/__tests__/smartglasses-basic-actions.test.ts",
      [
        "returns display action failures when no transport can send text",
        "returns microphone action failures when no transport can toggle mic",
      ],
    ),
  );
  failures.push(
    ...sourceTokenFailures(
      "plugins/plugin-facewear/src/__tests__/protocol-smartglasses.test.ts",
      [
        "wraps text into centered five-line display pages",
        "encodes microphone enable and disable packets",
        "parses tap and microphone audio notifications",
        "parses MentraOS G1 battery status responses",
      ],
    ),
  );
  failures.push(
    ...sourceTokenFailures(
      "packages/examples/smartglasses/smartglasses-protocol.test.ts",
      [
        "G1 display text wraps by measured display width and packet payload limit",
        "measureG1DisplayText",
        "G1_DISPLAY.maxPayloadBytes",
        "microphoneActionForInteractionEvent",
        "G1 microphone data exposes right-lens LC3 sequence and payload",
        "G1Command.ReceiveMicData",
      ],
    ),
  );
  failures.push(
    ...sourceTokenFailures(
      "plugins/plugin-facewear/src/__tests__/facewear-service.test.ts",
      [
        "FacewearService",
        "FACEWEAR_SERVICE_TYPE",
        "getConnectedDevices",
        "hasActiveDevice",
      ],
    ),
  );
  failures.push(
    ...sourceTokenFailures(
      "plugins/plugin-facewear/src/__tests__/smartglasses-view-report.test.ts",
      [
        "classifies whole-headset and partial pairing states",
        "requires wearing state, both lenses, display/settings, tap mic toggles, and audio",
        "normalizes View Manager Wi-Fi responses and rejects unsupported bridge commands",
        "requires microphone writes to happen after the matching side tap",
        "callWifiBridge",
        "does not support Wi-Fi command",
        "whole_headset_seen",
        "display-result",
      ],
    ),
  );
  failures.push(
    ...sourceTokenFailures(
      "plugins/plugin-facewear/src/__tests__/xr-smartglasses-bridge.test.ts",
      ["g1_raw", "mic_lc3", "single_tap", "microphoneEnabled"],
    ),
  );
  failures.push(
    ...sourceTokenFailures(
      "plugins/plugin-facewear/src/__tests__/smartglasses-control-action.test.ts",
      [
        "returns action failures for invalid parameters instead of throwing",
        "requests battery status from both lenses",
        "requests voice-note metadata before fetch/delete operations",
        "voice-note delete-all",
        "returns packet counts for app allowlist and G1 setup operations",
        "returns packet counts for navigation image transfers",
        "sends secondary navigation image transfers through both lenses",
        "dispatches the full control-action G1 command surface",
        "routes setup-friendly aliases to canonical G1 operations",
        '"app_allowlist"',
        '"wifi_connect"',
        '"request_wifi_setup"',
        '"quick_note_fetch"',
        '"wifi_configure"',
        '"navigation_directions"',
        '"translate_translated"',
        '"bmp_image"',
      ],
    ),
  );
  failures.push(
    ...sourceTokenFailures(
      "packages/examples/smartglasses/eliza-runtime-smoke.ts",
      [
        "Runtime smoke did not return display action page count",
        "Runtime smoke did not return microphone action state",
        "Runtime smoke did not return control action failure details",
        "Runtime smoke did not configure Wi-Fi through setup alias",
        "Runtime smoke did not request Wi-Fi setup through setup alias",
        "Runtime smoke did not return canonical alias op names",
        "Runtime smoke did not send app allowlist alias packets",
        "Runtime smoke did not send QuickNote alias packets",
        "Runtime smoke did not send previous-page alias packets",
        "Runtime smoke did not send next-page alias packets",
        "Smartglasses brightness command failed",
        "displayResult",
        "microphoneResult",
        "invalidControlResult",
        "aliasWifiConnectResult",
        "aliasQuickNoteResult",
      ],
    ),
  );
  failures.push(
    ...sourceTokenFailures("packages/examples/smartglasses/package-smoke.ts", [
      "Package smoke did not return G1 setup packet count",
      "Package smoke did not return navigation image packet count",
      "Package smoke did not return display failure without transport",
      "Package smoke did not return microphone failure without transport",
      "Package smoke did not return control failure for invalid parameters",
      "Package smoke did not send start AI packets",
      "Package smoke did not send clear display packets",
      "Package smoke did not send exit dashboard packets",
      "Package smoke did not send page-up packets",
      "Package smoke did not send page-down packets",
      "Package smoke did not send brightness packets",
      "Package smoke did not send app allowlist packets",
      "Package smoke did not send notification packets",
      "Package smoke did not send BMP data packets",
      "Package smoke did not return app allowlist packet count",
      "Package smoke did not return notification packet count",
      "Package smoke did not return BMP byte count",
      "Smartglasses brightness command failed",
      '"navigation_primary_image"',
      "navigationImageResult",
      "g1SetupResult",
      "appWhitelistResult",
      "notificationResult",
      "bmpImageResult",
    ]),
  );
  failures.push(
    ...sourceTokenFailures("plugins/plugin-facewear/src/index.ts", [
      "facewearControlAction",
      "facewearStatusAction",
      "facewearMicrophoneAction",
      "displayFacewearTextAction",
      "smartglassesControlAction",
      "smartglassesStatusAction",
      "smartglassesMicrophoneAction",
      "displaySmartglassesTextAction",
    ]),
  );
  failures.push(
    ...sourceTokenFailures("plugins/plugin-facewear/registry-entry.json", [
      '"npmName": "@elizaos/plugin-facewear"',
      "whole-headset pairing",
      "side-tap mic control",
      '"target": "facewear"',
    ]),
  );
  failures.push(
    ...sourceTokenFailures("packages/app/src/plugin-registrations.ts", [
      '"@elizaos/plugin-facewear/register"',
      'import("@elizaos/plugin-facewear/register")',
    ]),
  );
  failures.push(
    ...sourceTokenFailures(
      "plugins/plugin-facewear/src/transport/web-bluetooth.ts",
      [
        'await this.connectLens("left")',
        'await this.connectLens("right")',
        "await this.disconnect()",
        "this.sides.size === 2",
        'const nameMarker = side === "left" ? "_L_" : "_R_"',
        "findConnectedDeviceSide",
        "EVEN_G1_UART.service",
        "parseG1Notification",
        "this.audioCallbacks",
      ],
    ),
  );
  failures.push(
    ...sourceTokenFailures("plugins/plugin-facewear/src/transport/noble.ts", [
      'this.connectPeripheral("left"',
      'this.connectPeripheral("right"',
      "await this.disconnect()",
      "return this.sides.size === 2",
      "/_L_|left/i",
      "/_R_|right/i",
      "SERVICE_UUID",
      "parseG1Notification",
      "this.audioCallbacks",
    ]),
  );
  failures.push(
    ...sourceTokenFailures(
      "packages/examples/smartglasses/bleak-hardware-smoke.py",
      [
        '"discoveredDevices"',
        '"pairedG1Devices"',
        '"bluetoothAdapter"',
        '"scanDiagnosis"',
        "parse_system_profiler_bluetooth",
        '"_L_" in name',
        '"_R_" in name',
        '"whole_headset_seen"',
        "await smoke.wait_for_wearing()",
        'await self.write("right", bytes([0x0E, 0x01]))',
        'await self.write("right", bytes([0x0E, 0x00]))',
        "has_tap_driven_right_mic_write",
        "next_evidence_order",
        '"audioObserved"',
        'chunk.get("side") == "right"',
        "setup_hint_for_blocker",
      ],
    ),
  );
  failures.push(
    ...sourceTokenFailures(
      "packages/examples/smartglasses/noble-hardware-smoke.ts",
      [
        "NobleG1Transport",
        "recordHardwareWrite",
        "markHardwareMicrophoneCommand",
        "service.onRawAudio",
        "recordHardwareAudio",
        "transport.onEvent",
        "recordHardwareEvent",
        "waitForWearing",
        'service.sendConnectionReady("both", initMode)',
        'service.requestSerial("both")',
        "service.displayText",
        "service.setMicrophoneEnabled(true)",
        "service.setMicrophoneEnabled(false)",
        "missingCompleteHardwareEvidence",
        "writeFile(reportPath",
      ],
    ),
  );
  failures.push(
    ...sourceTokenFailures(
      "packages/examples/smartglasses/hardware-evidence.ts",
      [
        "REQUIRED_HARDWARE_EVIDENCE",
        "pairedG1Devices",
        "bluetoothAdapter",
        "microphoneEnableWriteAfterTap",
        "microphoneDisableWriteAfterTap",
        "missingCompleteHardwareEvidence",
        "missingLeftLensConnection",
        "missingRightLensConnection",
        "missingStatusLeftLensConnection",
        "missingStatusRightLensConnection",
        "missingRightLensAudioChunk",
        "headsetInCradle",
        "wearingStateNotObserved",
        "updateTapDrivenMicWriteChecks",
        "hardwarePhysicalBlocker",
        "wholeHeadsetConnected",
        "hardwareScanDiagnosis",
        "nextActionForHardwareBlocker",
        "setupHintForHardwareBlocker",
      ],
    ),
  );
  failures.push(
    ...sourceTokenFailures(
      "packages/examples/smartglasses/validate-hardware-report.ts",
      [
        "VALIDATION_FAILURE_DESCRIPTIONS",
        "validateHardwareReport",
        "createHardwareValidationSummary",
        "missingCompleteHardwareEvidence(report, { requireFinishedAt: true })",
        "isHardwareReportStale",
        "reportStale",
        "reportNotMarkedOk",
        "hardwareReportAgeMs",
        "scanDiagnosis",
        "physicalBlocker",
        "pairedG1Devices",
        "pairedG1DeviceCount",
        "pairedWholeHeadset",
        "bluetoothAdapter",
        "bluetoothPreflightSource",
        "inspectLocalBluetoothPreflight",
        "nextActionForHardwareBlocker",
        "--max-age-ms",
        "missingRightLensAudioChunk",
        "wearingStateNotObserved",
      ],
    ),
  );
  failures.push(
    ...sourceTokenFailures(
      "packages/examples/smartglasses/hardware-report-status.ts",
      [
        "createMissingHardwareReportStatus",
        "existsSync(reportPath)",
        "missingReport",
        "pairedG1Devices",
        "pairedG1DeviceCount",
        "pairedWholeHeadset",
        "bluetoothAdapter",
        "bluetoothPreflightSource",
        "inspectLocalBluetoothPreflight",
      ],
    ),
  );
  failures.push(
    ...sourceTokenFailures(
      "packages/examples/smartglasses/hardware-local-bluetooth.ts",
      [
        "inspectLocalBluetoothPreflight",
        "clearLocalBluetoothPreflightCache",
        "parseSystemProfilerBluetooth",
        "system_profiler",
        "SPBluetoothDataType",
        "pairedG1Devices",
        "bluetoothAdapter",
      ],
    ),
  );
  failures.push(
    ...sourceTokenFailures(
      "plugins/plugin-facewear/native/android/even-realities/app/src/main/java/com/elizaos/facewear/evenrealities/G1BleService.kt",
      [
        "cmdOpenMic = 0x0E.toByte()",
        "writeSide(GlassSide.RIGHT",
        'name.contains("_L_"',
        'name.contains("_R_"',
        "GlassSide.LEFT",
        "GlassSide.RIGHT",
      ],
    ),
  );
  failures.push(
    ...sourceTokenFailures(
      "plugins/plugin-facewear/native/android/even-realities/app/src/main/java/com/elizaos/facewear/evenrealities/AgentBridgeService.kt",
      [
        '"g1_raw"',
        '"mic_lc3"',
        '"clear_display"',
        '"brightness"',
        '"battery_status"',
      ],
    ),
  );

  const completionAudit = readText(
    "plugins/plugin-facewear/docs/smartglasses-completion-audit.md",
  );
  for (const expected of [
    "bun run --cwd packages/examples/smartglasses hardware:prove:bleak:watch",
    "bun run --cwd packages/examples/smartglasses hardware:doctor",
    "bun run --cwd packages/examples/smartglasses hardware:validate-latest",
    "reportStale",
    "Blocked on physical headset advertising/availability",
  ]) {
    if (!completionAudit.includes(expected)) {
      failures.push(
        `plugins/plugin-facewear/docs/smartglasses-completion-audit.md: missing ${expected}`,
      );
    }
  }

  const upstreamAudit = readText(
    "plugins/plugin-facewear/docs/smartglasses-upstream-audit.md",
  );
  for (const expected of [
    "fabioglimb/even-toolkit",
    "BxNxM/even-dev",
    "emingenc/even_glasses",
    "binarythinktank/eveng1_python_sdk",
    "meyskens/fahrplan",
    "nickustinov/weather-even-g2",
    "jappyjan/even-realities",
    "emingenc/g1_flutter_blue_plus",
    "nickustinov/tesla-even-g2",
    "galfaroth/awesome-even-realities-g1",
    "even-realities/EvenDemoApp",
    "Mentra-Community/MentraOS",
  ]) {
    if (!upstreamAudit.includes(expected)) {
      failures.push(
        `plugins/plugin-facewear/docs/smartglasses-upstream-audit.md: missing ${expected}`,
      );
    }
  }

  const smartglassesDocs = readText(
    "plugins/plugin-facewear/docs/smartglasses.md",
  );
  for (const expected of [
    "bun run audit:smartglasses-software",
    "bun run --cwd packages/examples/smartglasses dev:hardware",
    "bun run --cwd packages/examples/smartglasses dev:simulator",
    "bun run --cwd packages/examples/smartglasses simulator",
    "bun run --cwd packages/examples/smartglasses smoke:simulator",
    "bun run --cwd packages/examples/smartglasses hardware:status-latest",
    "bun run --cwd packages/examples/smartglasses hardware:validate-latest",
    "bun run --cwd packages/examples/smartglasses hardware:prove:bleak",
    "bun run --cwd packages/examples/smartglasses hardware:prove:bleak:watch",
    "bun run --cwd packages/examples/smartglasses hardware:prove:noble",
    "bun run --cwd packages/examples/smartglasses hardware:prove:noble:watch",
    "docs/smartglasses-upstream-audit.md",
    "SMARTGLASSES_DISPLAY_TEXT",
    "SMARTGLASSES_MICROPHONE",
    "SMARTGLASSES_CONTROL",
    "Direct G1 hardware sends `0xF1` packets containing LC3 frames",
    "Direct G1 BLE does not expose a verified Wi-Fi provisioning command",
  ]) {
    if (!smartglassesDocs.includes(expected)) {
      failures.push(
        `plugins/plugin-facewear/docs/smartglasses.md: missing ${expected}`,
      );
    }
  }
  if (smartglassesDocs.includes("docs/upstream-audit.md")) {
    failures.push(
      "plugins/plugin-facewear/docs/smartglasses.md: stale docs/upstream-audit.md link",
    );
  }

  const exampleReadme = readText("packages/examples/smartglasses/README.md");
  for (const expected of [
    "bun run audit:smartglasses-software",
    "For the final auditable hardware proof run, use the root latest-report helpers.",
    "Check current setup state first:",
    "bun run --cwd packages/examples/smartglasses hardware:doctor",
    "bun run --cwd packages/examples/smartglasses hardware:status-latest",
    "Then run the default CoreBluetooth/Bleak proof:",
    "bun run --cwd packages/examples/smartglasses hardware:validate-latest",
    "bun run --cwd packages/examples/smartglasses hardware:prove:bleak",
    "Use Noble only when its native binding is compatible with the current runtime:",
    "bun run --cwd packages/examples/smartglasses hardware:prove:bleak:watch",
    "bun run --cwd packages/examples/smartglasses hardware:prove:noble",
    "bun run --cwd packages/examples/smartglasses hardware:prove:noble:watch",
    "charging base, wear them",
    "keep them near this Mac",
    "safe before the first proof run",
    "Package-local equivalents are available when you are already working inside the",
    "Validate the fresh latest artifact independently before treating physical",
    "bun run --cwd packages/examples/smartglasses dev:hardware",
    "bun run --cwd packages/examples/smartglasses dev:simulator",
    "bun run --cwd packages/examples/smartglasses simulator",
    "bun run --cwd packages/examples/smartglasses smoke:simulator",
    "Even Realities research audit self-test",
    "Even Realities research audit",
    "smartglasses completion self-test",
    "bun run --cwd packages/examples/smartglasses verify:software",
    "hardware:prove:bleak:watch",
    "hardware:doctor",
    'physicalBlocker: "headset_not_found"',
  ]) {
    if (!exampleReadme.includes(expected)) {
      failures.push(
        `packages/examples/smartglasses/README.md: missing ${expected}`,
      );
    }
  }

  for (const scriptName of [
    "audit:even-research",
    "audit:even-research:self-test",
    "audit:smartglasses-completion",
    "audit:smartglasses-completion:self-test",
    "audit:smartglasses-software",
  ]) {
    if (!rootScripts[scriptName])
      failures.push(`package.json: missing script ${scriptName}`);
  }
  return failures;
}

function hardwareGateSummary(path, freshnessMs) {
  if (!existsSync(path)) {
    return missingHardwareGateSummary(path, inspectBluetoothPreflight());
  }

  const report = JSON.parse(readFileSync(path, "utf8"));
  return hardwareGateSummaryFromReport(report, path, freshnessMs);
}

function missingHardwareGateSummary(path, bluetoothPreflight = null) {
  const pairedG1Devices = bluetoothPreflight?.pairedG1Devices ?? [];
  const bluetoothAdapter = bluetoothPreflight?.bluetoothAdapter ?? null;
  const pairedWholeHeadset =
    pairedG1Devices.some((device) => device.side === "left") &&
    pairedG1Devices.some((device) => device.side === "right");
  return {
    ok: false,
    reportPath: path,
    failures: ["missingReport"],
    pairedG1Devices,
    pairedG1DeviceCount: pairedG1Devices.length,
    pairedWholeHeadset,
    bluetoothAdapter,
    bluetoothPreflightSource: bluetoothPreflight ? "local" : "none",
    physicalBlocker: pairedWholeHeadset ? "headset_not_found" : null,
    nextAction: pairedWholeHeadset
      ? "Remove both lenses from the base, keep them near this device, wear them, then run `bun run --cwd packages/examples/smartglasses hardware:prove:bleak:watch` from the repo root."
      : "From the repo root, run `bun run --cwd packages/examples/smartglasses hardware:prove:bleak:watch` with both lenses worn.",
  };
}

function hardwareGateSummaryFromReport(
  report,
  path,
  freshnessMs,
  bluetoothPreflight = inspectBluetoothPreflight(),
) {
  const failures = hardwareFailures(report, freshnessMs);
  const discoveredDevices = report.discoveredDevices ?? [];
  const pairedG1Devices =
    report.pairedG1Devices?.length > 0
      ? report.pairedG1Devices
      : (bluetoothPreflight?.pairedG1Devices ?? []);
  const bluetoothAdapter =
    report.bluetoothAdapter ?? bluetoothPreflight?.bluetoothAdapter ?? null;
  const bluetoothPreflightSource =
    report.pairedG1Devices?.length > 0 || report.bluetoothAdapter
      ? "report"
      : bluetoothPreflight
        ? "local"
        : "none";
  const status = report.status ?? {};
  return {
    ok: failures.length === 0,
    reportPath: path,
    startedAt: report.startedAt ?? null,
    finishedAt: report.finishedAt ?? null,
    reportAgeMs: hardwareReportAgeMs(report),
    maxAgeMs: freshnessMs,
    failures,
    scanDiagnosis: report.scanDiagnosis ?? hardwareScanDiagnosis(report),
    discoveredDeviceCount: discoveredDevices.length,
    discoveredG1DeviceCount: discoveredDevices.filter(
      (device) => device.matchesG1,
    ).length,
    pairedG1Devices,
    pairedG1DeviceCount: pairedG1Devices.length,
    pairedWholeHeadset:
      pairedG1Devices.some((device) => device.side === "left") &&
      pairedG1Devices.some((device) => device.side === "right"),
    bluetoothAdapter,
    bluetoothPreflightSource,
    wholeHeadsetConnected: wholeHeadsetConnected(report),
    wearingReady: report.headsetState?.physical === "wearing",
    physicalBlocker: physicalBlocker(report),
    serial: status.lastSerialNumber ?? null,
    audioChunks: report.audio?.length ?? 0,
    nextAction: nextAction(report),
  };
}

function hardwareFailures(report, freshnessMs) {
  const failures = [];
  const checks = report.checks ?? {};
  for (const check of [
    "connected",
    "connectionReadySent",
    "displayPacketsSent",
    "serialRequested",
    "serialObserved",
    "settingsSent",
    "tapObserved",
    "microphoneEnabledByTap",
    "microphoneEnableWriteAfterTap",
    "microphoneDisabledByTap",
    "microphoneDisableWriteAfterTap",
    "audioObserved",
  ]) {
    if (!checks[check]) failures.push(check);
  }
  if (!report.finishedAt) failures.push("missingFinishedAt");
  if (!wholeHeadsetConnected(report)) failures.push("wholeHeadsetNotConnected");
  if (!report.status?.lastSerialNumber) failures.push("missingSerialNumber");
  if ((report.status?.audioChunksReceived ?? 0) < 1)
    failures.push("missingStatusAudioChunks");
  if (!hasTapDrivenMicWrite(report, "enable"))
    failures.push("missingMicEnableWriteAfterTap");
  if (!hasTapDrivenMicWrite(report, "disable"))
    failures.push("missingMicDisableWriteAfterTap");
  if (!hasRightAudio(report)) failures.push("missingRightLensAudioChunk");
  if (report.headsetState?.physical !== "wearing")
    failures.push("wearingStateNotObserved");
  if (!report.ok) failures.push("reportNotMarkedOk");
  if (isStale(report, freshnessMs)) failures.push("reportStale");
  return [...new Set(failures)];
}

function hasTapDrivenMicWrite(report, mode) {
  const labels =
    mode === "enable"
      ? ["single_tap", "long_press"]
      : ["double_tap", "stop_ai_recording"];
  const prefix = mode === "enable" ? "0e01" : "0e00";
  const events = (report.events ?? []).filter((event) =>
    labels.includes(event.label),
  );
  const writes = (report.writes ?? []).filter(
    (write) =>
      write.side === "right" &&
      write.command === "open-mic" &&
      String(write.hex ?? "").startsWith(prefix),
  );
  return events.some((event) =>
    writes.some((write) =>
      typeof event.order === "number" && typeof write.order === "number"
        ? write.order > event.order
        : String(write.at ?? "") >= String(event.at ?? ""),
    ),
  );
}

function hasRightAudio(report) {
  return (report.audio ?? []).some(
    (chunk) => chunk.side === "right" && chunk.bytes > 0,
  );
}

function wholeHeadsetConnected(report) {
  const lenses = report.lenses ?? {};
  const connectedLenses = report.status?.connectedLenses ?? {};
  return Boolean(
    report.status?.connected &&
      lenses.left?.connected &&
      lenses.right?.connected &&
      connectedLenses.left?.connected &&
      connectedLenses.right?.connected,
  );
}

function hardwareScanDiagnosis(report) {
  if (report.lenses?.left?.connected && report.lenses?.right?.connected)
    return "whole_headset_seen";
  if (report.lenses?.left?.connected) return "right_lens_missing";
  if (report.lenses?.right?.connected) return "left_lens_missing";
  const discovered = report.discoveredDevices ?? [];
  if (discovered.length === 0)
    return report.finishedAt ? "no_ble_devices" : "not_scanned";
  if (discovered.some((device) => device.matchesG1))
    return "g1_candidates_seen";
  return report.finishedAt ? "ble_seen_no_g1_candidates" : "not_scanned";
}

function physicalBlocker(report) {
  if (report.status && !report.status.available) return "transport_unavailable";
  const anyLens =
    report.lenses?.left?.connected ||
    report.lenses?.right?.connected ||
    report.status?.connectedLenses?.left?.connected ||
    report.status?.connectedLenses?.right?.connected;
  if (report.status?.available && !anyLens) return "headset_not_found";
  if (!report.status?.connected) return "disconnected";
  if (!wholeHeadsetConnected(report)) return "partial_headset";
  return report.headsetState?.physical === "wearing"
    ? null
    : "wearing_state_missing";
}

function nextAction(report) {
  const blocker = physicalBlocker(report);
  if (blocker === "headset_not_found") {
    return "Remove both lenses from the base, keep them near this device, wear them, then run `bun run --cwd packages/examples/smartglasses hardware:prove:bleak:watch` from the repo root.";
  }
  if (blocker === "wearing_state_missing") {
    return "Wear the connected glasses until physical=wearing, then single tap, speak, and double tap.";
  }
  if (blocker === "partial_headset")
    return "Reconnect both left and right lenses as one headset.";
  if (blocker === "transport_unavailable")
    return "Use Bleak/CoreBluetooth or repair the Noble native binding.";
  return "Run `bun run --cwd packages/examples/smartglasses hardware:prove:bleak:watch` from the repo root and satisfy all hardware evidence checks.";
}

function inspectBluetoothPreflight() {
  try {
    return parseSystemProfilerBluetooth(
      execFileSync("system_profiler", ["SPBluetoothDataType"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }),
    );
  } catch {
    return null;
  }
}

function parseSystemProfilerBluetooth(source) {
  const lines = source.split(/\r?\n/);
  const bluetoothAdapter = {
    available: true,
    state: valueAfter(lines, "State:"),
    discoverable: valueAfter(lines, "Discoverable:"),
    chipset: valueAfter(lines, "Chipset:"),
    address: valueAfter(lines, "Address:"),
  };
  const pairedG1Devices = [];
  let section = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "Connected:") {
      section = "connected";
      continue;
    }
    if (trimmed === "Not Connected:") {
      section = "not_connected";
      continue;
    }
    const match = trimmed.match(/^(Even\s+G1[^:]*_(L|R)_[^:]+):$/i);
    if (!match) continue;
    pairedG1Devices.push({
      name: match[1],
      side: match[2].toUpperCase() === "L" ? "left" : "right",
      connected: section === "connected",
      section,
    });
  }
  return { bluetoothAdapter, pairedG1Devices };
}

function valueAfter(lines, prefix) {
  const line = lines.find((candidate) => candidate.trim().startsWith(prefix));
  return line ? line.trim().slice(prefix.length).trim() : null;
}

function hardwareReportAgeMs(report) {
  const timestamp = Date.parse(report.finishedAt ?? report.startedAt ?? "");
  return Number.isFinite(timestamp)
    ? Math.max(0, Date.now() - timestamp)
    : null;
}

function isStale(report, freshnessMs) {
  if (!Number.isFinite(freshnessMs) || freshnessMs < 0) return true;
  const age = hardwareReportAgeMs(report);
  return age === null || age > freshnessMs;
}

function readJson(relPath) {
  try {
    return JSON.parse(readFileSync(resolve(repoRoot, relPath), "utf8"));
  } catch {
    return null;
  }
}

function readText(relPath) {
  try {
    return readFileSync(resolve(repoRoot, relPath), "utf8");
  } catch {
    return "";
  }
}

function sourceTokenFailures(relPath, expectedTokens) {
  const source = readText(relPath);
  return expectedTokens
    .filter((token) => !source.includes(token))
    .map((token) => `${relPath}: missing ${token}`);
}

function staleSmartglassesReferenceFailures() {
  const removedWorkspace = removedSmartglassesWorkspace();
  const removedRegistryEntry = removedSmartglassesRegistryEntry();
  const criticalFiles = [
    "bun.lock",
    "package.json",
    "packages/app/package.json",
    "packages/examples/smartglasses/package.json",
  ];
  const sources = Object.fromEntries(
    criticalFiles.map((relPath) => [relPath, readText(relPath)]),
  );
  const failures = staleSmartglassesReferenceFailuresFromSources(sources);
  if (existsSync(resolve(repoRoot, removedWorkspace))) {
    failures.push(`${removedWorkspace}: removed workspace still exists`);
  }
  if (existsSync(resolve(repoRoot, removedRegistryEntry))) {
    failures.push(
      `${removedRegistryEntry}: removed registry entry still exists`,
    );
  }
  return failures;
}

function staleSmartglassesReferenceFailuresFromSources(sources) {
  const failures = [];
  const removedPackage = removedSmartglassesPackage();
  const removedWorkspace = removedSmartglassesWorkspace();
  const removedRegistryEntry = removedSmartglassesRegistryEntry();
  const removedRegistryTest = ["smartglasses", "registry"].join("-");
  for (const [relPath, source] of Object.entries(sources)) {
    if (source.includes(removedPackage)) {
      failures.push(`${relPath}: still references ${removedPackage}`);
    }
    if (source.includes(removedWorkspace)) {
      failures.push(`${relPath}: still references ${removedWorkspace}`);
    }
    if (source.includes(removedRegistryEntry)) {
      failures.push(`${relPath}: still references removed registry entry`);
    }
    if (source.includes(removedRegistryTest)) {
      failures.push(`${relPath}: still references removed registry test`);
    }
  }
  return failures;
}

function removedSmartglassesPackage() {
  return ["@elizaos/plugin", "smartglasses"].join("-");
}

function removedSmartglassesWorkspace() {
  return ["plugins/plugin", "smartglasses"].join("-");
}

function removedSmartglassesRegistryEntry() {
  return ["plugins/plugin-smartglasses", "registry-entry.json"].join("/");
}

function runSelfTest() {
  const completeReport = {
    ok: true,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    checks: {
      connected: true,
      connectionReadySent: true,
      displayPacketsSent: true,
      serialRequested: true,
      serialObserved: true,
      settingsSent: true,
      tapObserved: true,
      microphoneEnabledByTap: true,
      microphoneEnableWriteAfterTap: true,
      microphoneDisabledByTap: true,
      microphoneDisableWriteAfterTap: true,
      audioObserved: true,
    },
    lenses: { left: { connected: true }, right: { connected: true } },
    status: {
      connected: true,
      connectedLenses: {
        left: { connected: true },
        right: { connected: true },
      },
      lastSerialNumber: "G1SERIAL",
      audioChunksReceived: 1,
    },
    pairedG1Devices: [
      { name: "Even G1_51_L_TEST", side: "left", connected: true },
      { name: "Even G1_51_R_TEST", side: "right", connected: true },
    ],
    bluetoothAdapter: { available: true, state: "On" },
    headsetState: { physical: "wearing" },
    writes: [
      {
        order: 2,
        at: "2026-05-20T00:00:02Z",
        side: "right",
        command: "open-mic",
        hex: "0e01",
      },
      {
        order: 4,
        at: "2026-05-20T00:00:04Z",
        side: "right",
        command: "open-mic",
        hex: "0e00",
      },
    ],
    events: [
      { order: 1, at: "2026-05-20T00:00:01Z", label: "single_tap" },
      { order: 3, at: "2026-05-20T00:00:03Z", label: "double_tap" },
    ],
    audio: [{ side: "right", bytes: 10 }],
  };
  const failures = [];
  if (hardwareFailures(completeReport, 600000).length !== 0) {
    failures.push("complete report fixture failed");
  }
  const completeSummary = hardwareGateSummaryFromReport(
    completeReport,
    "/tmp/complete.json",
    600000,
  );
  if (
    completeSummary.pairedG1DeviceCount !== 2 ||
    completeSummary.pairedWholeHeadset !== true ||
    completeSummary.bluetoothAdapter?.state !== "On" ||
    completeSummary.bluetoothPreflightSource !== "report"
  ) {
    failures.push("paired preflight summary fixture failed");
  }
  const softwareFailures = softwareGateFailures();
  if (softwareFailures.length > 0) {
    failures.push(...softwareFailures.map((failure) => `software: ${failure}`));
  }
  const removedPackage = removedSmartglassesPackage();
  const removedWorkspace = removedSmartglassesWorkspace();
  const staleReferenceFixture = staleSmartglassesReferenceFailuresFromSources({
    "bun.lock": [
      `"${removedPackage}": "workspace:*"`,
      `"${removedWorkspace}": {`,
    ].join("\n"),
    "package.json": "",
    "packages/app/package.json": "",
    "packages/examples/smartglasses/package.json": "",
  });
  if (
    !staleReferenceFixture.includes(
      `bun.lock: still references ${removedPackage}`,
    ) ||
    !staleReferenceFixture.includes(
      `bun.lock: still references ${removedWorkspace}`,
    )
  ) {
    failures.push("stale smartglasses reference fixture failed");
  }
  const staleFailureReport = {
    ...completeReport,
    ok: false,
    finishedAt: "2026-05-20T00:00:00Z",
    audio: [],
  };
  const reportFailures = hardwareFailures(staleFailureReport, 1);
  for (const expected of [
    "missingRightLensAudioChunk",
    "reportNotMarkedOk",
    "reportStale",
  ]) {
    if (!reportFailures.includes(expected)) {
      failures.push(`missing fixture failure ${expected}`);
    }
  }
  const parsedBluetooth = parseSystemProfilerBluetooth(`
Bluetooth:
  State: On
  Discoverable: Off
  Chipset: BCM_4387
  Address: 00:11:22:33:44:55
  Connected:
    Even G1_51_L_TEST:
  Not Connected:
    Even G1_51_R_TEST:
`);
  const legacySummary = hardwareGateSummaryFromReport(
    { ...completeReport, pairedG1Devices: [], bluetoothAdapter: null },
    "/tmp/legacy.json",
    600000,
    parsedBluetooth,
  );
  if (
    legacySummary.pairedG1DeviceCount !== 2 ||
    legacySummary.pairedWholeHeadset !== true ||
    legacySummary.bluetoothAdapter?.chipset !== "BCM_4387" ||
    legacySummary.bluetoothPreflightSource !== "local"
  ) {
    failures.push("legacy report bluetooth preflight fallback fixture failed");
  }
  const missingSummary = missingHardwareGateSummary(
    "/tmp/missing-smartglasses-report.json",
    parsedBluetooth,
  );
  if (
    missingSummary.failures[0] !== "missingReport" ||
    missingSummary.pairedG1DeviceCount !== 2 ||
    missingSummary.pairedWholeHeadset !== true ||
    missingSummary.bluetoothPreflightSource !== "local" ||
    missingSummary.physicalBlocker !== "headset_not_found" ||
    !missingSummary.nextAction.includes("hardware:prove:bleak:watch")
  ) {
    failures.push("missing report bluetooth preflight summary fixture failed");
  }
  if (failures.length > 0) {
    console.error(JSON.stringify({ ok: false, failures }, null, 2));
    process.exit(1);
  }
  console.log(
    JSON.stringify({ ok: true, fixtures: 3, software: true }, null, 2),
  );
}

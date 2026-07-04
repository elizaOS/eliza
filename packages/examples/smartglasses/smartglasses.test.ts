import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  G1Command,
  G1DashboardLayout,
  type G1Event,
  MockSmartglassesTransport,
  SmartglassesService,
} from "@elizaos/plugin-facewear";
import {
  createHardwareDoctorSummary,
  hardwareReportAgeMs,
  parseSystemProfilerBluetooth,
} from "./hardware-doctor.mjs";
import {
  createHardwareEvidenceReport,
  hardwareCommandName,
  hardwarePhysicalBlocker,
  missingCompleteHardwareEvidence,
  missingHardwareEvidence,
  recordHardwareAudio,
  recordHardwareEvent,
  recordHardwareWrite,
  updateHardwareEvidenceStatus,
} from "./hardware-evidence.js";
import {
  clearLocalBluetoothPreflightCache,
  inspectLocalBluetoothPreflight,
  parseSystemProfilerBluetooth as parseLocalSystemProfilerBluetooth,
} from "./hardware-local-bluetooth.js";
import {
  createHardwareReportStatus,
  createMissingHardwareReportStatus,
} from "./hardware-report-status.js";
import {
  createHardwareValidationSummary,
  isHardwareReportStale,
  validateHardwareReport,
} from "./validate-hardware-report.js";

const PACKAGE_JSON_PATH = join(import.meta.dirname, "package.json");

test("smartglasses example packet path", async () => {
  const transport = new MockSmartglassesTransport();
  const service = new SmartglassesService();
  service.setTransport(transport);
  const rawAudio: Array<{ bytes: number[]; encoding: string | undefined }> = [];
  const decodedPcm: number[][] = [];

  service.setAudioDecoder(() => Uint8Array.from([0, 0, 0, 64]));
  service.onRawAudio((audio, _sampleRate, _side, encoding) =>
    rawAudio.push({ bytes: Array.from(audio), encoding }),
  );
  service.onAudio((pcm) => decodedPcm.push(Array.from(pcm)));

  await service.displayText("hello from eliza");
  await service.displayRsvpText("quick rsvp display", {
    wordsPerGroup: 2,
    mode: "text",
    skipDelay: true,
  });
  await service.pageUp();
  await service.pageDown();
  service.startHeartbeatLoop({ intervalMs: 1000 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  service.stopHeartbeatLoop();
  await service.setBrightness(3, false);
  await service.setDashboardPosition(3, 7);
  await service.setDashboardLayout(G1DashboardLayout.Dual);
  await service.sendDashboardCalendarItem({
    name: "Eliza",
    time: "13:30-14:30",
    location: "Lab",
  });
  await service.sendDashboardTimeWeather({
    seqId: 1,
    timestampMs: 1_700_000_000_000,
    timezoneOffsetSeconds: 0,
    temperatureInCelsius: 21,
    weatherIcon: 0x10,
  });
  await service.sendG1Setup({ calendar_enable: true });
  await service.startNavigation();
  await service.sendNavigationDirections({
    totalDuration: "4 min",
    totalDistance: "1 km",
    direction: "Main St",
    distance: "200 m",
    speed: "30",
    directionTurn: 0x03,
  });
  await service.sendNavigationPoller();
  await service.endNavigation();
  await service.sendTranslateSetup();
  await service.startTranslate();
  await service.setTranslateLanguages(0x02, 0x05);
  await service.sendTranslateText("translated", "bonjour", 3);
  await service.scanWifi();
  await service.configureWifi("TestNet", "secret");
  await service.requestWifiSetup("Test needs headset Wi-Fi");
  await service.getWifiStatus();
  await service.sendConnectionReady();
  await service.sendConnectionReady("both", "official");
  await service.sendConnectionReady("both", "android-f4");
  await service.exitFunction();
  await service.requestSerial("right");
  await service.sendAppWhitelist({ apps: ["eliza"] });
  await service.sendRaw(Uint8Array.from([0x4d, 0x01]), "left");
  await service.requestVoiceNoteAudio(1, { syncId: 2 });
  await service.deleteVoiceNoteAudio(1, { syncId: 3 });
  await service.sendMonochromeBmpImage(Uint8Array.from([0, 255, 255, 0]), {
    width: 2,
    height: 2,
  });
  transport.emitRaw("left", Uint8Array.from([0xf5, 0x17]));
  await Promise.resolve();
  transport.emitRaw("right", Uint8Array.from([0xf1, 7, 1, 2, 3, 4]));
  transport.emitRaw(
    "right",
    Uint8Array.from([
      G1Command.GetSerial,
      0xc9,
      ...new TextEncoder().encode("G1RIGHTSERIAL001"),
      0,
    ]),
  );
  transport.emitRaw("left", Uint8Array.from([0xf5, 0x18]));
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(
    transport.writes.some((write) => write.data[0] === G1Command.SendResult),
  ).toBe(true);
  expect(
    transport.writes.some((write) => write.data[0] === G1Command.Brightness),
  ).toBe(true);
  expect(
    transport.writes.some(
      (write) => write.data[0] === G1Command.DashboardContent,
    ),
  ).toBe(true);
  expect(
    transport.writes.some(
      (write) =>
        write.data[0] === G1Command.DashboardPosition &&
        write.data[1] === 0x08 &&
        write.data[6] === 3 &&
        write.data[7] === 7,
    ),
  ).toBe(true);
  expect(
    transport.writes.some((write) => write.data[0] === G1Command.Navigation),
  ).toBe(true);
  expect(
    transport.writes.some(
      (write) => write.data[0] === G1Command.TranslateSetup,
    ),
  ).toBe(true);
  expect(
    transport.writes.some(
      (write) => write.data[0] === G1Command.TranslateTranslatedText,
    ),
  ).toBe(true);
  expect(
    transport.writes.some(
      (write) => write.side === "left" && write.data[0] === G1Command.Init,
    ),
  ).toBe(true);
  expect(
    transport.writes.some(
      (write) =>
        write.side === "right" && write.data[0] === G1Command.RightInit,
    ),
  ).toBe(true);
  expect(
    transport.writes.filter(
      (write) =>
        write.data[0] === G1Command.Init &&
        write.data[1] === 0x01 &&
        (write.side === "left" || write.side === "right"),
    ).length,
  ).toBeGreaterThanOrEqual(3);
  expect(
    transport.writes.filter(
      (write) =>
        write.data[0] === G1Command.RightInit &&
        write.data[1] === 0x01 &&
        (write.side === "left" || write.side === "right"),
    ).length,
  ).toBeGreaterThanOrEqual(3);
  expect(
    transport.writes.some((write) => write.data[0] === G1Command.ExitFunction),
  ).toBe(true);
  expect(
    transport.writes.some((write) => write.data[0] === G1Command.GetSerial),
  ).toBe(true);
  expect(
    transport.writes.some((write) => write.data[0] === G1Command.AppWhitelist),
  ).toBe(true);
  expect(
    transport.writes.some(
      (write) =>
        write.side === "left" && write.data[0] === 0x4d && write.data[1] === 1,
    ),
  ).toBe(true);
  expect(
    transport.writes.some(
      (write) =>
        write.side === "right" &&
        write.data[0] === G1Command.Note &&
        write.data[3] === 2 &&
        write.data[4] === 2,
    ),
  ).toBe(true);
  expect(
    transport.writes.some(
      (write) =>
        write.side === "right" &&
        write.data[0] === G1Command.Note &&
        write.data[3] === 3 &&
        write.data[4] === 4,
    ),
  ).toBe(true);
  expect(
    transport.writes.some(
      (write) =>
        write.data[0] === G1Command.BmpData &&
        write.data[6] === 0x42 &&
        write.data[7] === 0x4d,
    ),
  ).toBe(true);
  expect(
    transport.writes.some(
      (write) =>
        write.side === "left" &&
        write.data[0] === G1Command.StartAi &&
        write.data[1] === 1,
    ),
  ).toBe(true);
  expect(
    transport.writes.some(
      (write) =>
        write.side === "right" &&
        write.data[0] === G1Command.StartAi &&
        write.data[1] === 1,
    ),
  ).toBe(true);
  expect(
    transport.writes.some((write) => write.data[0] === G1Command.Heartbeat),
  ).toBe(true);
  expect(
    transport.writes.some(
      (write) =>
        write.side === "right" &&
        write.data[0] === G1Command.OpenMic &&
        write.data[1] === 1,
    ),
  ).toBe(true);
  expect(Array.from(transport.writes.at(-1)?.data ?? [])).toEqual([
    G1Command.OpenMic,
    0,
  ]);
  expect(rawAudio).toEqual([{ bytes: [1, 2, 3, 4], encoding: "lc3" }]);
  expect(decodedPcm).toEqual([[0, 0.5]]);
  expect(service.getStatus()).toMatchObject({
    audioChunksReceived: 1,
    lastAudioEncoding: "lc3",
    lastAudioSequence: 7,
    audioSequenceGaps: 0,
    microphoneEnabled: false,
    lastSerialNumber: "G1RIGHTSERIAL001",
    wifiAvailable: true,
    lastWifiStatus: {
      status: "mock-wifi-ready",
      networks: ["MockNet"],
    },
  });
  expect(transport.wifiRequests).toEqual([
    { op: "scan" },
    { op: "configure", ssid: "TestNet", password: "secret" },
    { op: "setup", reason: "Test needs headset Wi-Fi" },
    { op: "status" },
  ]);
});

test("hardware proof scripts include short and watch latest-report wrappers", () => {
  const packageJson = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8")) as {
    scripts: Record<string, string>;
  };

  expect(packageJson.scripts["hardware:prove:bleak"]).toContain(
    "hardware:bleak:latest",
  );
  expect(packageJson.scripts["hardware:prove:bleak:watch"]).toContain(
    "hardware:bleak:watch",
  );
  expect(packageJson.scripts["hardware:prove:noble"]).toContain(
    "hardware:noble:latest",
  );
  expect(packageJson.scripts["hardware:prove:noble:watch"]).toContain(
    "hardware:noble:watch",
  );
  for (const script of [
    "hardware:prove:bleak",
    "hardware:prove:bleak:watch",
    "hardware:prove:noble",
    "hardware:prove:noble:watch",
  ]) {
    expect(packageJson.scripts[script]).toContain("hardware:status-latest");
    expect(packageJson.scripts[script]).toContain("hardware:validate-latest");
  }
});

test("hardware evidence helper requires display, serial, tap mic toggles, and audio", () => {
  const report = createHardwareEvidenceReport({
    initMode: "lens-specific",
    scanTimeoutMs: 10,
    holdMs: 20,
  });
  const status = {
    available: true,
    connected: true,
    transport: "mock",
    connectedLenses: {
      left: { connected: true, name: "Even G1_51_L_TEST" },
      right: { connected: true, name: "Even G1_51_R_TEST" },
    },
    microphoneEnabled: false,
    heartbeatRunning: false,
    heartbeatIntervalMs: null,
    lastHeartbeatAt: null,
    lastEvent: null,
    lastTranscript: null,
    audioChunksReceived: 1,
    lastAudioEncoding: "lc3",
    lastAudioSequence: 9,
    audioSequenceGaps: 0,
    physicalState: "wearing",
    batteryState: null,
    deviceState: "connected",
    lastSerialNumber: "G1RIGHTSERIAL001",
  } as const;

  report.checks.connected = true;
  recordHardwareWrite(report, "left", Uint8Array.from([G1Command.Init, 1]));
  recordHardwareWrite(report, "both", Uint8Array.from([G1Command.GetSerial]));
  recordHardwareWrite(report, "both", Uint8Array.from([G1Command.SendResult]));
  recordHardwareWrite(report, "both", Uint8Array.from([G1Command.Brightness]));
  recordHardwareEvent(report, {
    side: "right",
    raw: Uint8Array.from([G1Command.GetSerial, 0xc9]),
    type: "serial",
    label: "serial_number",
    serialNumber: "G1RIGHTSERIAL001",
  } satisfies G1Event);
  recordHardwareEvent(report, {
    side: "left",
    raw: Uint8Array.from([G1Command.StartAi, 0x06]),
    type: "state",
    label: "wearing",
    stateCategory: "physical",
    stateName: "wearing",
  } satisfies G1Event);
  recordHardwareEvent(report, {
    side: "left",
    raw: Uint8Array.from([G1Command.StartAi, 0x17]),
    type: "state",
    label: "single_tap",
  } satisfies G1Event);
  recordHardwareWrite(report, "right", Uint8Array.from([G1Command.OpenMic, 1]));
  recordHardwareEvent(report, {
    side: "left",
    raw: Uint8Array.from([G1Command.StartAi, 0x18]),
    type: "state",
    label: "double_tap",
  } satisfies G1Event);
  recordHardwareWrite(report, "right", Uint8Array.from([G1Command.OpenMic, 0]));
  recordHardwareAudio(
    report,
    Uint8Array.from([1, 2, 3]),
    16_000,
    "right",
    "lc3",
    9,
  );
  updateHardwareEvidenceStatus(report, status);

  expect(report.ok).toBe(true);
  expect(missingCompleteHardwareEvidence(report)).toEqual([]);
  expect(validateHardwareReport(report)).toContain("missingFinishedAt");

  report.finishedAt = new Date().toISOString();
  updateHardwareEvidenceStatus(report, status);

  expect(report.ok).toBe(true);
  expect(missingHardwareEvidence(report)).toEqual([]);
  expect(validateHardwareReport(report)).toEqual([]);
  expect(createHardwareValidationSummary("/tmp/complete.json", report)).toEqual(
    expect.objectContaining({
      ok: true,
      reportPath: "/tmp/complete.json",
      initMode: "lens-specific",
      writes: 6,
      events: 4,
      audioChunks: 1,
      serial: "G1RIGHTSERIAL001",
      scanDiagnosis: "whole_headset_seen",
      audioEncoding: "lc3",
      audioSequenceGaps: 0,
      headsetState: expect.objectContaining({
        physical: "wearing",
        device: "connected",
      }),
    }),
  );
  expect(report.writes.map((write) => write.command)).toEqual([
    "init",
    "get-serial",
    "display-result",
    "brightness",
    "open-mic",
    "open-mic",
  ]);
  expect(report.audio).toEqual([
    expect.objectContaining({
      side: "right",
      sampleRate: 16_000,
      encoding: "lc3",
      sequence: 9,
      bytes: 3,
    }),
  ]);
  expect(hardwareCommandName(Uint8Array.from([0xab]))).toBe("0xab");
});

test("hardware report status exposes whole-headset and wearing readiness", () => {
  const report = createHardwareEvidenceReport({
    initMode: "lens-specific",
  });

  expect(report.scanDiagnosis).toBe("not_scanned");
  report.bluetoothAdapter = {
    available: true,
    state: "On",
    discoverable: "Off",
    chipset: "BCM_4387",
    address: "00:11:22:33:44:55",
  };
  report.pairedG1Devices = [
    {
      name: "Even G1_51_L_TEST",
      side: "left",
      connected: false,
      section: "not_connected",
    },
    {
      name: "Even G1_51_R_TEST",
      side: "right",
      connected: false,
      section: "not_connected",
    },
  ];

  updateHardwareEvidenceStatus(report, {
    available: true,
    connected: true,
    transport: "mock",
    connectedLenses: {
      left: { connected: true, name: "Even G1_51_L_TEST" },
      right: { connected: true, name: "Even G1_51_R_TEST" },
    },
    microphoneEnabled: false,
    heartbeatRunning: false,
    heartbeatIntervalMs: null,
    lastHeartbeatAt: null,
    lastEvent: null,
    lastTranscript: null,
    audioChunksReceived: 0,
    lastAudioEncoding: null,
    lastAudioSequence: null,
    audioSequenceGaps: 0,
    physicalState: "charged_in_cradle",
    batteryState: "cradle_fully_charged",
    deviceState: "connected",
    lastSerialNumber: "G1RIGHTSERIAL001",
  });

  expect(report.scanDiagnosis).toBe("whole_headset_seen");
  expect(createHardwareReportStatus("/tmp/report.json", report)).toMatchObject({
    scanDiagnosis: "whole_headset_seen",
    wholeHeadsetConnected: true,
    wearingReady: false,
    physicalBlocker: "in_charging_base",
    pairedG1DeviceCount: 2,
    pairedWholeHeadset: true,
    bluetoothAdapter: expect.objectContaining({
      state: "On",
      chipset: "BCM_4387",
    }),
    bluetoothPreflightSource: "report",
    setupHint:
      "Glasses are reporting charged_in_cradle / cradle_fully_charged; remove them from the charging base and wear them before tap or microphone validation.",
    nextAction:
      "Remove both lenses from the charging base, wear the glasses, single tap, speak, then double tap.",
  });
});

test("hardware report status prioritizes whole-headset setup hints", () => {
  const unavailableReport = createHardwareEvidenceReport({
    initMode: "lens-specific",
  });
  updateHardwareEvidenceStatus(unavailableReport, {
    available: false,
    connected: false,
    transport: null,
    connectedLenses: {},
    microphoneEnabled: false,
    heartbeatRunning: false,
    heartbeatIntervalMs: null,
    lastHeartbeatAt: null,
    lastEvent: null,
    lastTranscript: null,
    audioChunksReceived: 0,
    lastAudioEncoding: null,
    lastAudioSequence: null,
    audioSequenceGaps: 0,
    physicalState: null,
    batteryState: null,
    deviceState: null,
    lastSerialNumber: null,
  });

  expect(hardwarePhysicalBlocker(unavailableReport)).toBe(
    "transport_unavailable",
  );
  expect(
    createHardwareReportStatus("/tmp/unavailable.json", unavailableReport),
  ).toMatchObject({
    wholeHeadsetConnected: false,
    wearingReady: false,
    physicalBlocker: "transport_unavailable",
    setupHint:
      "The hardware transport is unavailable before headset discovery. Use the Bleak/CoreBluetooth smoke on macOS, or install/rebuild the Noble native BLE binding for this runtime.",
    nextAction:
      "From the repo root, run `bun run --cwd packages/examples/smartglasses hardware:prove:bleak` for macOS CoreBluetooth proof, or rebuild @abandonware/noble before using `bun run --cwd packages/examples/smartglasses hardware:prove:noble`.",
  });

  const disconnectedReport = createHardwareEvidenceReport({
    initMode: "lens-specific",
  });

  expect(
    createHardwareReportStatus("/tmp/disconnected.json", disconnectedReport),
  ).toMatchObject({
    wholeHeadsetConnected: false,
    wearingReady: false,
    physicalBlocker: "disconnected",
    setupHint:
      "Connect both lenses as one headset before running hardware validation.",
    nextAction:
      "Connect both lenses as one headset before running hardware validation.",
  });

  const noLensReport = createHardwareEvidenceReport({
    initMode: "lens-specific",
  });
  noLensReport.discoveredDevices = [
    {
      name: "Keyboard",
      address: "AA:BB",
      rssi: -42,
      serviceUuids: [],
      manufacturerIds: [76],
      matchesG1: false,
      matchReason: null,
    },
    {
      name: "Even G1_51_L_TEST",
      address: "CC:DD",
      rssi: -58,
      serviceUuids: ["6e400001-b5a3-f393-e0a9-e50e24dcca9e"],
      manufacturerIds: [],
      matchesG1: true,
      matchReason: "name",
    },
  ];
  updateHardwareEvidenceStatus(noLensReport, {
    available: true,
    connected: true,
    transport: "mock",
    connectedLenses: {},
    microphoneEnabled: false,
    heartbeatRunning: false,
    heartbeatIntervalMs: null,
    lastHeartbeatAt: null,
    lastEvent: null,
    lastTranscript: null,
    audioChunksReceived: 0,
    lastAudioEncoding: null,
    lastAudioSequence: null,
    audioSequenceGaps: 0,
    physicalState: null,
    batteryState: null,
    deviceState: null,
    lastSerialNumber: null,
  });

  expect(hardwarePhysicalBlocker(noLensReport)).toBe("headset_not_found");
  expect(noLensReport.setupHint).toBe(
    "No G1 lenses were found. Remove both lenses from the charging base, keep them near this device, and rerun hardware pairing.",
  );
  expect(
    createHardwareReportStatus("/tmp/no-lenses.json", noLensReport),
  ).toMatchObject({
    discoveredDeviceCount: 2,
    discoveredG1DeviceCount: 1,
    scanDiagnosis: "g1_candidates_seen",
    discoveredDevices: [
      {
        name: "Keyboard",
        matchesG1: false,
      },
      {
        name: "Even G1_51_L_TEST",
        matchesG1: true,
        matchReason: "name",
        serviceUuids: ["6e400001-b5a3-f393-e0a9-e50e24dcca9e"],
      },
    ],
    wholeHeadsetConnected: false,
    wearingReady: false,
    physicalBlocker: "headset_not_found",
    setupHint:
      "No G1 lenses were found. Remove both lenses from the charging base, keep them near this device, and rerun hardware pairing.",
    nextAction:
      "Remove both lenses from the charging base, keep them near this device, then run `bun run --cwd packages/examples/smartglasses hardware:prove:bleak:watch` from the repo root.",
  });

  noLensReport.scanDiagnosis = "ble_seen_no_g1_candidates";
  expect(
    createHardwareReportStatus("/tmp/no-lenses.json", noLensReport),
  ).toMatchObject({
    scanDiagnosis: "ble_seen_no_g1_candidates",
  });

  const partialReport = createHardwareEvidenceReport({
    initMode: "lens-specific",
  });
  updateHardwareEvidenceStatus(partialReport, {
    available: true,
    connected: true,
    transport: "mock",
    connectedLenses: {
      left: { connected: true, name: "Even G1_51_L_TEST" },
    },
    microphoneEnabled: false,
    heartbeatRunning: false,
    heartbeatIntervalMs: null,
    lastHeartbeatAt: null,
    lastEvent: null,
    lastTranscript: null,
    audioChunksReceived: 0,
    lastAudioEncoding: null,
    lastAudioSequence: null,
    audioSequenceGaps: 0,
    physicalState: "wearing",
    batteryState: null,
    deviceState: "connected",
    lastSerialNumber: null,
  });

  expect(
    createHardwareReportStatus("/tmp/partial.json", partialReport),
  ).toMatchObject({
    scanDiagnosis: "right_lens_missing",
    wholeHeadsetConnected: false,
    wearingReady: false,
    physicalBlocker: "partial_headset",
    setupHint:
      "Reconnect the whole headset so both left and right lenses are present.",
    nextAction:
      "Reconnect the whole headset so both left and right lenses are present.",
  });

  const noWearingReport = createHardwareEvidenceReport({
    initMode: "lens-specific",
  });
  updateHardwareEvidenceStatus(noWearingReport, {
    available: true,
    connected: true,
    transport: "mock",
    connectedLenses: {
      left: { connected: true, name: "Even G1_51_L_TEST" },
      right: { connected: true, name: "Even G1_51_R_TEST" },
    },
    microphoneEnabled: false,
    heartbeatRunning: false,
    heartbeatIntervalMs: null,
    lastHeartbeatAt: null,
    lastEvent: null,
    lastTranscript: null,
    audioChunksReceived: 0,
    lastAudioEncoding: null,
    lastAudioSequence: null,
    audioSequenceGaps: 0,
    physicalState: null,
    batteryState: null,
    deviceState: "connected",
    lastSerialNumber: "G1RIGHTSERIAL001",
  });

  expect(
    createHardwareReportStatus("/tmp/no-wearing.json", noWearingReport),
  ).toMatchObject({
    wholeHeadsetConnected: true,
    wearingReady: false,
    physicalBlocker: "wearing_state_missing",
    nextAction:
      "Wear the glasses until they report wearing, or run `bun run --cwd packages/examples/smartglasses hardware:prove:bleak:watch` from the repo root for a longer latest-report proof window; then single tap, speak, and double tap.",
  });
});

test("hardware report status exposes report age and stale latest evidence", () => {
  const report = createHardwareEvidenceReport({
    initMode: "lens-specific",
  });
  report.startedAt = "2026-05-20T06:00:00.000Z";
  report.finishedAt = "2026-05-20T06:01:00.000Z";

  expect(
    createHardwareReportStatus("/tmp/latest.json", report, {
      now: "2026-05-20T06:03:30.000Z",
      staleAfterMs: 5 * 60 * 1000,
    }),
  ).toMatchObject({
    startedAt: "2026-05-20T06:00:00.000Z",
    finishedAt: "2026-05-20T06:01:00.000Z",
    reportAgeSeconds: 150,
    reportStale: false,
    staleAfterSeconds: 300,
  });

  expect(
    createHardwareReportStatus("/tmp/latest.json", report, {
      now: "2026-05-20T06:11:01.000Z",
      staleAfterMs: 5 * 60 * 1000,
    }),
  ).toMatchObject({
    reportAgeSeconds: 601,
    reportStale: true,
    failures: expect.arrayContaining(["reportStale"]),
  });
});

test("hardware report status is useful before the latest report exists", () => {
  const localBluetooth = parseLocalSystemProfilerBluetooth(`
Bluetooth:
  State: On
  Discoverable: Off
  Chipset: BCM_4387
  Address: 00:11:22:33:44:55
  Not Connected:
    Even G1_51_L_TEST:
    Even G1_51_R_TEST:
`);

  expect(
    createMissingHardwareReportStatus("/tmp/missing.json", {
      localBluetooth,
      staleAfterMs: 10 * 60 * 1000,
    }),
  ).toMatchObject({
    ok: false,
    reportPath: "/tmp/missing.json",
    reportStale: true,
    staleAfterSeconds: 600,
    pairedG1DeviceCount: 2,
    pairedWholeHeadset: true,
    bluetoothAdapter: expect.objectContaining({
      state: "On",
      chipset: "BCM_4387",
    }),
    bluetoothPreflightSource: "local",
    scanDiagnosis: "not_scanned",
    wholeHeadsetConnected: false,
    physicalBlocker: "headset_not_found",
    setupHint:
      "Both G1 lenses are paired locally, but no latest proof report exists yet.",
    nextAction:
      "Remove both lenses from the charging base, wear them near this device, then run `bun run --cwd packages/examples/smartglasses hardware:prove:bleak:watch` from the repo root.",
    failures: ["missingReport"],
    failureDetails: [
      {
        failure: "missingReport",
        description:
          "No latest hardware report exists yet; run the hardware proof command to create one.",
      },
    ],
  });
});

test("hardware report validator can require fresh latest evidence", () => {
  const report = createHardwareEvidenceReport({
    initMode: "lens-specific",
  });
  report.startedAt = "2026-05-20T06:00:00.000Z";
  report.finishedAt = "2026-05-20T06:01:00.000Z";

  expect(
    isHardwareReportStale(report, 5 * 60 * 1000, "2026-05-20T06:03:00.000Z"),
  ).toBe(false);
  expect(
    isHardwareReportStale(report, 5 * 60 * 1000, "2026-05-20T06:07:00.000Z"),
  ).toBe(true);
  expect(
    isHardwareReportStale(report, Number.NaN, "2026-05-20T06:03:00.000Z"),
  ).toBe(true);
  expect(
    validateHardwareReport(report, {
      maxAgeMs: 5 * 60 * 1000,
      now: "2026-05-20T06:07:00.000Z",
    }),
  ).toContain("reportStale");
});

test("hardware report validator summary includes scan diagnosis", () => {
  const report = createHardwareEvidenceReport({
    initMode: "lens-specific",
  });
  report.finishedAt = "2026-05-20T06:01:00.000Z";
  report.bluetoothAdapter = {
    available: true,
    state: "On",
    discoverable: "Off",
    chipset: "BCM_4387",
    address: "00:11:22:33:44:55",
  };
  report.pairedG1Devices = [
    {
      name: "Even G1_51_L_TEST",
      side: "left",
      connected: false,
      section: "not_connected",
    },
    {
      name: "Even G1_51_R_TEST",
      side: "right",
      connected: false,
      section: "not_connected",
    },
  ];
  report.discoveredDevices = [
    {
      name: "Keyboard",
      address: "AA:BB",
      rssi: -42,
      serviceUuids: [],
      manufacturerIds: [76],
      matchesG1: false,
      matchReason: null,
    },
  ];

  expect(
    createHardwareValidationSummary("/tmp/no-g1.json", report, {
      maxAgeMs: 10 * 60 * 1000,
      now: "2026-05-20T06:02:00.000Z",
    }),
  ).toMatchObject({
    ok: false,
    reportPath: "/tmp/no-g1.json",
    discoveredDeviceCount: 1,
    discoveredG1DeviceCount: 0,
    pairedG1DeviceCount: 2,
    pairedWholeHeadset: true,
    bluetoothAdapter: expect.objectContaining({
      state: "On",
      chipset: "BCM_4387",
    }),
    bluetoothPreflightSource: "report",
    scanDiagnosis: "ble_seen_no_g1_candidates",
    physicalBlocker: "disconnected",
    reportAgeMs: 60_000,
    failures: expect.arrayContaining(["connected"]),
  });

  report.scanDiagnosis = "g1_candidates_seen";
  expect(
    createHardwareValidationSummary("/tmp/no-g1.json", report),
  ).toMatchObject({
    scanDiagnosis: "g1_candidates_seen",
  });
});

test("hardware report status and validator fall back to local bluetooth preflight", () => {
  const report = createHardwareEvidenceReport({
    initMode: "lens-specific",
  });
  report.finishedAt = "2026-05-20T06:01:00.000Z";

  const localBluetooth = parseLocalSystemProfilerBluetooth(`
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

  expect(
    createHardwareReportStatus("/tmp/legacy.json", report, {
      now: "2026-05-20T06:02:00.000Z",
      localBluetooth,
    }),
  ).toMatchObject({
    pairedG1DeviceCount: 2,
    pairedWholeHeadset: true,
    bluetoothAdapter: expect.objectContaining({
      state: "On",
      chipset: "BCM_4387",
    }),
    bluetoothPreflightSource: "local",
  });

  expect(
    createHardwareValidationSummary("/tmp/legacy.json", report, {
      maxAgeMs: 10 * 60 * 1000,
      now: "2026-05-20T06:02:00.000Z",
      localBluetooth,
    }),
  ).toMatchObject({
    pairedG1DeviceCount: 2,
    pairedWholeHeadset: true,
    pairedG1Devices: [
      expect.objectContaining({
        name: "Even G1_51_L_TEST",
        side: "left",
        connected: true,
      }),
      expect.objectContaining({
        name: "Even G1_51_R_TEST",
        side: "right",
        connected: false,
      }),
    ],
    bluetoothAdapter: expect.objectContaining({
      address: "00:11:22:33:44:55",
    }),
    bluetoothPreflightSource: "local",
  });
});

test("local bluetooth preflight cache can be cleared", () => {
  clearLocalBluetoothPreflightCache();
  let reads = 0;
  const leftOnly = `
Bluetooth:
  State: On
  Connected:
    Even G1_51_L_CACHE:
`;
  const rightOnly = `
Bluetooth:
  State: On
  Connected:
    Even G1_51_R_CACHE:
`;

  const first = inspectLocalBluetoothPreflight({
    cache: true,
    read: () => {
      reads += 1;
      return leftOnly;
    },
  });
  const second = inspectLocalBluetoothPreflight({
    cache: true,
    read: () => {
      reads += 1;
      return rightOnly;
    },
  });

  expect(reads).toBe(1);
  expect(second).toEqual(first);
  expect(second?.pairedG1Devices).toEqual([
    expect.objectContaining({ name: "Even G1_51_L_CACHE", side: "left" }),
  ]);

  clearLocalBluetoothPreflightCache();
  const third = inspectLocalBluetoothPreflight({
    cache: true,
    read: () => {
      reads += 1;
      return rightOnly;
    },
  });

  expect(reads).toBe(2);
  expect(third?.pairedG1Devices).toEqual([
    expect.objectContaining({ name: "Even G1_51_R_CACHE", side: "right" }),
  ]);
  clearLocalBluetoothPreflightCache();
});

test("hardware report validator rejects incomplete reports", () => {
  const report = createHardwareEvidenceReport({
    initMode: "lens-specific",
  });

  expect(validateHardwareReport(report)).toEqual(
    expect.arrayContaining([
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
      "reportNotMarkedOk",
      "missingFinishedAt",
      "statusNotConnected",
      "missingSerialNumber",
      "missingStatusAudioChunks",
      "missingWrites",
      "missingEvents",
      "missingAudioChunks",
      "missingInitWrite",
      "missingDisplayWrite",
      "missingSerialRequestWrite",
      "missingSettingsWrite",
      "missingSerialEvent",
      "missingMicEnableTapEvent",
      "missingMicDisableTapEvent",
      "missingMicEnableWrite",
      "missingMicDisableWrite",
      "missingMicEnableWriteAfterTap",
      "missingMicDisableWriteAfterTap",
      "missingNonEmptyAudioChunk",
      "missingRightLensAudioChunk",
      "wearingStateNotObserved",
    ]),
  );
});

test("hardware report validator requires tap-driven microphone writes", () => {
  const report = createHardwareEvidenceReport({
    initMode: "lens-specific",
  });

  recordHardwareWrite(report, "right", Uint8Array.from([G1Command.OpenMic, 1]));
  recordHardwareEvent(report, {
    side: "left",
    raw: Uint8Array.from([G1Command.StartAi, 0x17]),
    type: "state",
    label: "single_tap",
  } satisfies G1Event);

  expect(validateHardwareReport(report)).toEqual(
    expect.arrayContaining(["missingMicEnableWriteAfterTap"]),
  );

  recordHardwareWrite(report, "right", Uint8Array.from([G1Command.OpenMic, 1]));

  expect(validateHardwareReport(report)).not.toContain(
    "missingMicEnableWriteAfterTap",
  );
});

test("hardware report validator flags cradle state separately from tap and audio gaps", () => {
  const report = createHardwareEvidenceReport({
    initMode: "official",
  });

  recordHardwareEvent(report, {
    side: "left",
    raw: Uint8Array.from([G1Command.StartAi, 0x09]),
    type: "state",
    label: "charged_in_cradle",
    stateCategory: "physical",
    stateName: "charged_in_cradle",
  } satisfies G1Event);
  updateHardwareEvidenceStatus(report, {
    available: true,
    connected: true,
    transport: "mock",
    connectedLenses: {
      left: { connected: true, name: "Even G1_51_L_TEST" },
      right: { connected: true, name: "Even G1_51_R_TEST" },
    },
    microphoneEnabled: false,
    heartbeatRunning: false,
    heartbeatIntervalMs: null,
    lastHeartbeatAt: null,
    lastEvent: null,
    lastTranscript: null,
    audioChunksReceived: 0,
    lastAudioEncoding: null,
    lastAudioSequence: null,
    audioSequenceGaps: 0,
    physicalState: "charged_in_cradle",
    batteryState: "cradle_fully_charged",
    deviceState: "connected",
    lastSerialNumber: null,
  });

  expect(report.headsetState).toMatchObject({
    physical: "charged_in_cradle",
    battery: "cradle_fully_charged",
    device: "connected",
  });
  expect(report.setupHint).toContain("remove them from the charging base");
  expect(validateHardwareReport(report)).toEqual(
    expect.arrayContaining(["headsetInCradle", "wearingStateNotObserved"]),
  );
});

test("hardware evidence status updates replace stale cradle state with wearing state", () => {
  const report = createHardwareEvidenceReport({
    initMode: "lens-specific",
  });

  updateHardwareEvidenceStatus(report, {
    available: true,
    connected: true,
    transport: "mock",
    microphoneEnabled: false,
    heartbeatRunning: false,
    heartbeatIntervalMs: null,
    lastHeartbeatAt: null,
    lastEvent: null,
    lastTranscript: null,
    audioChunksReceived: 0,
    lastAudioEncoding: null,
    lastAudioSequence: null,
    audioSequenceGaps: 0,
    physicalState: "charged_in_cradle",
    batteryState: "cradle_fully_charged",
    deviceState: "connected",
    lastSerialNumber: null,
  });
  updateHardwareEvidenceStatus(report, {
    available: true,
    connected: true,
    transport: "mock",
    microphoneEnabled: false,
    heartbeatRunning: false,
    heartbeatIntervalMs: null,
    lastHeartbeatAt: null,
    lastEvent: null,
    lastTranscript: null,
    audioChunksReceived: 0,
    lastAudioEncoding: null,
    lastAudioSequence: null,
    audioSequenceGaps: 0,
    physicalState: "wearing",
    batteryState: "cradle_fully_charged",
    deviceState: "connected",
    lastSerialNumber: null,
  });

  expect(report.headsetState.physical).toBe("wearing");
  expect(validateHardwareReport(report)).not.toContain("headsetInCradle");
  expect(validateHardwareReport(report)).not.toContain(
    "wearingStateNotObserved",
  );
});

test("hardware doctor explains paired but not advertising whole headset", () => {
  const bluetooth = parseSystemProfilerBluetooth(`
Bluetooth:
  Controller:
    State: On
    Discoverable: Off
    Chipset: BCM_4387
    Address: 6C:B1:33:9E:A8:66
  Devices:
    Not Connected:
      Even G1_51_L_138507:
      Even G1_51_R_8C0CDF:
`);

  const summary = createHardwareDoctorSummary({
    bluetooth,
    latestReport: {
      reportPath: "/tmp/smartglasses-hardware-report-latest.json",
      ok: false,
      startedAt: "2026-05-20T10:38:40.099322Z",
      finishedAt: "2026-05-20T10:39:00.253237Z",
      scanDiagnosis: "ble_seen_no_g1_candidates",
      discoveredDeviceCount: 30,
      discoveredG1DeviceCount: 0,
      wholeHeadsetConnected: false,
      physicalBlocker: "headset_not_found",
      serial: null,
      audioChunks: 0,
      stale: true,
    },
  });

  expect(summary).toMatchObject({
    ok: false,
    wholeHeadsetPaired: true,
    pairedG1Devices: [
      {
        name: "Even G1_51_L_138507",
        side: "left",
        connected: false,
        section: "not_connected",
      },
      {
        name: "Even G1_51_R_8C0CDF",
        side: "right",
        connected: false,
        section: "not_connected",
      },
    ],
    latestReport: {
      physicalBlocker: "headset_not_found",
      wholeHeadsetConnected: false,
      discoveredG1DeviceCount: 0,
      stale: true,
    },
  });
  expect(
    hardwareReportAgeMs(
      { finishedAt: "2026-05-20T10:39:00Z" },
      Date.parse("2026-05-20T10:50:00Z"),
    ),
  ).toBe(660000);
  expect(summary.nextAction).toContain(
    "paired but not advertising/connectable",
  );
  expect(summary.nextAction).toContain("hardware:prove:bleak:watch");
});

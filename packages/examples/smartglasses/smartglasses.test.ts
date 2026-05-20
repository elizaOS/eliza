import { expect, test } from "bun:test";
import {
  G1Command,
  G1DashboardLayout,
  type G1Event,
  MockSmartglassesTransport,
  SmartglassesService,
} from "../../../plugins/plugin-smartglasses/src/index.js";
import {
  createHardwareEvidenceReport,
  hardwareCommandName,
  missingHardwareEvidence,
  recordHardwareAudio,
  recordHardwareEvent,
  recordHardwareWrite,
  updateHardwareEvidenceStatus,
} from "./hardware-evidence.js";
import { validateHardwareReport } from "./validate-hardware-report.js";

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
    transport.writes.some((write) => write.data[0] === G1Command.Navigation),
  ).toBe(true);
  expect(
    transport.writes.some((write) => write.data[0] === G1Command.TranslateSetup),
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
  });
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
    deviceState: null,
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
  recordHardwareEvent(report, {
    side: "left",
    raw: Uint8Array.from([G1Command.StartAi, 0x18]),
    type: "state",
    label: "double_tap",
  } satisfies G1Event);
  recordHardwareAudio(
    report,
    Uint8Array.from([1, 2, 3]),
    16_000,
    "right",
    "lc3",
    9,
  );
  updateHardwareEvidenceStatus(report, status);
  report.finishedAt = new Date().toISOString();

  expect(report.ok).toBe(true);
  expect(missingHardwareEvidence(report)).toEqual([]);
  expect(validateHardwareReport(report)).toEqual([]);
  expect(report.writes.map((write) => write.command)).toEqual([
    "init",
    "get-serial",
    "display-result",
    "brightness",
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
      "microphoneDisabledByTap",
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
      "missingNonEmptyAudioChunk",
      "missingRightLensAudioChunk",
      "wearingStateNotObserved",
    ]),
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
  expect(validateHardwareReport(report)).not.toContain("wearingStateNotObserved");
});

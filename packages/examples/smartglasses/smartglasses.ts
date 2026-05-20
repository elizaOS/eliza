import {
  G1Command,
  G1DashboardLayout,
  MockSmartglassesTransport,
  SmartglassesService,
} from "../../../plugins/plugin-smartglasses/src/index.js";

const transport = new MockSmartglassesTransport();
const service = new SmartglassesService();
service.setTransport(transport);
service.setAudioDecoder(() => Uint8Array.from([0, 0, 0, 64]));

service.onRawAudio((audio, sampleRate, side, encoding, sequence) => {
  console.log(
    `audio side=${side} sampleRate=${sampleRate} encoding=${encoding} sequence=${sequence ?? "none"} bytes=${audio.length}`,
  );
});
service.onAudio((pcm, sampleRate, side) => {
  console.log(`decoded pcm side=${side} sampleRate=${sampleRate} samples=${pcm.length}`);
});

await service.connect();
await service.displayText("Eliza is connected to Even Realities smartglasses.");
await service.displayText("Direct Text Show mode is available.", {
  mode: "text",
});
await service.displayRsvpText("RSVP display streams short word groups.", {
  wordsPerGroup: 2,
  mode: "text",
  skipDelay: true,
});
await service.pageUp();
await service.pageDown();
service.startHeartbeatLoop({ intervalMs: 1000 });
await new Promise((resolve) => setTimeout(resolve, 0));
service.stopHeartbeatLoop();
await service.setBrightness(10, true);
await service.setDashboard(true, 4);
await service.setDashboardLayout(G1DashboardLayout.Dual);
await service.sendDashboardCalendarItem({
  name: "Eliza standup",
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
await service.setHeadUpAngle(20);
await service.setSilentMode(false);
await service.setGlassesWearDetection(true);
await service.scanWifi();
await service.configureWifi("ExampleNet", "secret");
await service.getWifiStatus();
await service.sendConnectionReady();
await service.sendConnectionReady("both", "official");
await service.sendConnectionReady("both", "android-f4");
await service.exitFunction();
await service.requestSerial("right");
await service.sendAppWhitelist({ apps: ["eliza"] });
await service.sendRaw(Uint8Array.from([0x4d, 0x01]), "left");
await service.addOrUpdateNote(1, "Eliza", "Smartglasses example note");
await service.requestVoiceNoteAudio(1, { syncId: 2 });
await service.deleteVoiceNoteAudio(1, { syncId: 3 });
await service.sendMonochromeBmpImage(Uint8Array.from([0, 255, 255, 0]), {
  width: 2,
  height: 2,
});
await service.sendNotification({
  appIdentifier: "eliza",
  title: "Eliza",
  message: "Smartglasses example notification",
});

transport.emitRaw("left", Uint8Array.from([0xf5, 0x17]));
transport.emitRaw("right", Uint8Array.from([0xf1, 1, 0, 0, 0, 64]));
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
transport.emitRaw("right", Uint8Array.from([0xf5, 0x01]));
transport.emitRaw("right", Uint8Array.from([0xf5, 0x00]));
await new Promise((resolve) => setTimeout(resolve, 0));

const writes = transport.writes.map((write) => ({
  side: write.side,
  command: `0x${write.data[0].toString(16).padStart(2, "0")}`,
  bytes: Array.from(write.data),
}));

console.log(JSON.stringify({ status: service.getStatus(), writes }, null, 2));

if (!transport.writes.some((write) => write.data[0] === G1Command.SendResult)) {
  throw new Error("Example did not send display packets");
}
if (
  !transport.writes.some(
    (write) => write.data[0] === G1Command.OpenMic && write.data[1] === 1,
  )
) {
  throw new Error("Example did not enable the microphone");
}
if (
  !transport.writes.some(
    (write) => write.data[0] === G1Command.OpenMic && write.data[1] === 0,
  )
) {
  throw new Error("Example did not disable the microphone");
}
if (!transport.writes.some((write) => write.data[0] === G1Command.Brightness)) {
  throw new Error("Example did not send brightness settings");
}
if (
  !transport.writes.some(
    (write) => write.data[0] === G1Command.DashboardContent,
  )
) {
  throw new Error("Example did not send dashboard content packets");
}
if (!transport.writes.some((write) => write.data[0] === G1Command.Navigation)) {
  throw new Error("Example did not send navigation packets");
}
if (
  !transport.writes.some((write) => write.data[0] === G1Command.TranslateSetup)
) {
  throw new Error("Example did not send translation setup packets");
}
if (
  !transport.writes.some(
    (write) => write.data[0] === G1Command.TranslateTranslatedText,
  )
) {
  throw new Error("Example did not send translated text packets");
}
if (
  !transport.writes.some(
    (write) => write.side === "left" && write.data[0] === G1Command.Init,
  ) ||
  !transport.writes.some(
    (write) => write.side === "right" && write.data[0] === G1Command.RightInit,
  )
) {
  throw new Error("Example did not send connection-ready packets");
}
if (
  transport.writes.filter(
    (write) =>
      write.data[0] === G1Command.Init &&
      write.data[1] === 0x01 &&
      (write.side === "left" || write.side === "right"),
  ).length < 3
) {
  throw new Error("Example did not send official same-init packets");
}
if (
  transport.writes.filter(
    (write) =>
      write.data[0] === G1Command.RightInit &&
      write.data[1] === 0x01 &&
      (write.side === "left" || write.side === "right"),
  ).length < 3
) {
  throw new Error("Example did not send Android F4 same-init packets");
}
if (
  !transport.writes.some((write) => write.data[0] === G1Command.ExitFunction)
) {
  throw new Error("Example did not send native function-exit packets");
}
if (!transport.writes.some((write) => write.data[0] === G1Command.GetSerial)) {
  throw new Error("Example did not send serial request packets");
}
if (service.getStatus().lastSerialNumber !== "G1RIGHTSERIAL001") {
  throw new Error("Example did not parse serial response packets");
}
if (
  !transport.writes.some((write) => write.data[0] === G1Command.AppWhitelist)
) {
  throw new Error("Example did not send app whitelist packets");
}
if (
  !transport.writes.some(
    (write) => write.data[0] === 0x4d && write.data[1] === 0x01,
  )
) {
  throw new Error("Example did not send raw packets");
}
if (
  !transport.writes.some(
    (write) =>
      write.side === "left" &&
      write.data[0] === G1Command.StartAi &&
      write.data[1] === 1,
  ) ||
  !transport.writes.some(
    (write) =>
      write.side === "right" &&
      write.data[0] === G1Command.StartAi &&
      write.data[1] === 1,
  )
) {
  throw new Error("Example did not send manual page controls");
}
if (!transport.writes.some((write) => write.data[0] === G1Command.Heartbeat)) {
  throw new Error("Example did not send heartbeat packets");
}
if (
  !transport.writes.some((write) => write.data[0] === G1Command.Notification)
) {
  throw new Error("Example did not send notification packets");
}
if (
  !transport.writes.some(
    (write) =>
      write.data[0] === G1Command.Note &&
      write.data[3] === 2 &&
      write.data[4] === 2,
  )
) {
  throw new Error("Example did not send voice note fetch packets");
}
if (
  !transport.writes.some(
    (write) =>
      write.data[0] === G1Command.Note &&
      write.data[3] === 3 &&
      write.data[4] === 4,
  )
) {
  throw new Error("Example did not send voice note delete packets");
}
if (
  !transport.writes.some(
    (write) =>
      write.data[0] === G1Command.BmpData &&
      write.data[6] === 0x42 &&
      write.data[7] === 0x4d,
  )
) {
  throw new Error("Example did not send generated BMP packets");
}
if (
  JSON.stringify(transport.wifiRequests) !==
  JSON.stringify([
    { op: "scan" },
    { op: "configure", ssid: "ExampleNet", password: "secret" },
    { op: "status" },
  ])
) {
  throw new Error("Example did not exercise Wi-Fi service methods");
}
if (service.getStatus().lastWifiStatus?.status !== "mock-wifi-ready") {
  throw new Error("Example did not preserve Wi-Fi status");
}

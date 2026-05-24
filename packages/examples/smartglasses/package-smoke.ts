import {
  G1Command,
  MockSmartglassesTransport,
  SMARTGLASSES_AUDIO_EVENT,
  SMARTGLASSES_EVENT,
  SMARTGLASSES_SERVICE_NAME,
  SMARTGLASSES_TRANSCRIPT_EVENT,
  SmartglassesService,
  setSmartglassesAudioDecoderForRuntime,
  setSmartglassesTransportForRuntime,
  smartglassesPlugin,
} from "@elizaos/plugin-facewear";

if (smartglassesPlugin.name !== "@elizaos/plugin-facewear") {
  throw new Error("Unexpected plugin name from package export");
}

const transport = new MockSmartglassesTransport();
const services = new Map<string, unknown>();
const emitted: Array<{ event: string; params: Record<string, unknown> }> = [];
const runtime = {
  getSetting: (key: string) =>
    key === "SMARTGLASSES_TRANSPORT" ? "mock" : undefined,
  getService: (name: string) => services.get(name) ?? null,
  emitEvent: async (event: string, params: Record<string, unknown>) => {
    emitted.push({ event, params });
  },
};

setSmartglassesTransportForRuntime(transport);
setSmartglassesAudioDecoderForRuntime(() => Uint8Array.from([0, 0, 0, 64]));

try {
  const serviceClass = smartglassesPlugin.services?.find(
    (service) => service.serviceType === SMARTGLASSES_SERVICE_NAME,
  ) as
    | { serviceType?: string; start: (runtime: unknown) => Promise<unknown> }
    | undefined;
  if (!serviceClass) {
    throw new Error("Package smoke did not expose a service class");
  }

  const service = await serviceClass.start(runtime);
  services.set(serviceClass.serviceType ?? SMARTGLASSES_SERVICE_NAME, service);

  const displayAction = smartglassesPlugin.actions?.find(
    (action) => action.name === "SMARTGLASSES_DISPLAY_TEXT",
  );
  const controlAction = smartglassesPlugin.actions?.find(
    (action) => action.name === "SMARTGLASSES_CONTROL",
  );
  const microphoneAction = smartglassesPlugin.actions?.find(
    (action) => action.name === "SMARTGLASSES_MICROPHONE",
  );
  const statusProvider = smartglassesPlugin.providers?.find(
    (provider) => provider.name === "smartglassesStatus",
  );
  if (
    !displayAction ||
    !controlAction ||
    !microphoneAction ||
    !statusProvider
  ) {
    throw new Error("Package smoke did not expose expected plugin components");
  }

  const offlineService = new SmartglassesService();
  const offlineRuntime = {
    getService: (name: string) =>
      name === SMARTGLASSES_SERVICE_NAME ? offlineService : null,
  };
  const offlineDisplayResult = await displayAction.handler(
    offlineRuntime as never,
    { content: { text: '{"text":"offline display"}' } } as never,
  );
  const offlineMicResult = await microphoneAction.handler(
    offlineRuntime as never,
    { content: { text: "enable microphone" } } as never,
  );
  const invalidControlResult = await controlAction.handler(
    runtime as never,
    { content: { text: '{"op":"brightness"}' } } as never,
  );
  if (
    offlineDisplayResult.success !== false ||
    !String(offlineDisplayResult.text).includes(
      "Smartglasses display command failed",
    )
  ) {
    throw new Error(
      "Package smoke did not return display failure without transport",
    );
  }
  if (
    offlineMicResult.success !== false ||
    !String(offlineMicResult.text).includes(
      "Smartglasses microphone command failed",
    )
  ) {
    throw new Error(
      "Package smoke did not return microphone failure without transport",
    );
  }
  if (
    invalidControlResult.success !== false ||
    !String(invalidControlResult.text).includes(
      "Smartglasses brightness command failed",
    ) ||
    (invalidControlResult.values as { op?: string; error?: string } | undefined)
      ?.op !== "brightness"
  ) {
    throw new Error(
      "Package smoke did not return control failure for invalid parameters",
    );
  }

  await displayAction.handler(
    runtime as never,
    { content: { text: '{"text":"Package import smoke test"}' } } as never,
  );
  await microphoneAction.handler(
    runtime as never,
    { content: { text: "enable microphone" } } as never,
  );
  await controlAction.handler(
    runtime as never,
    {
      content: { text: '{"op":"battery_status"}' },
    } as never,
  );
  await controlAction.handler(
    runtime as never,
    { content: { text: '{"op":"clear"}' } } as never,
  );
  await controlAction.handler(
    runtime as never,
    { content: { text: '{"op":"exit_dashboard"}' } } as never,
  );
  await controlAction.handler(
    runtime as never,
    { content: { text: '{"op":"exit_function"}' } } as never,
  );
  await controlAction.handler(
    runtime as never,
    { content: { text: '{"op":"start_ai","subcommand":"start"}' } } as never,
  );
  await controlAction.handler(
    runtime as never,
    { content: { text: '{"op":"page_up"}' } } as never,
  );
  await controlAction.handler(
    runtime as never,
    { content: { text: '{"op":"page_down"}' } } as never,
  );
  await controlAction.handler(
    runtime as never,
    { content: { text: '{"op":"silent_mode","enabled":true}' } } as never,
  );
  await controlAction.handler(
    runtime as never,
    { content: { text: '{"op":"brightness","level":4}' } } as never,
  );
  await controlAction.handler(
    runtime as never,
    { content: { text: '{"op":"headup_angle","angle":8}' } } as never,
  );
  await controlAction.handler(
    runtime as never,
    { content: { text: '{"op":"wear_detection","enabled":true}' } } as never,
  );
  await controlAction.handler(
    runtime as never,
    {
      content: { text: '{"op":"voice_note_list","syncId":1}' },
    } as never,
  );
  await controlAction.handler(
    runtime as never,
    {
      content: { text: '{"op":"voice_note_fetch","noteIndex":1,"syncId":2}' },
    } as never,
  );
  await controlAction.handler(
    runtime as never,
    {
      content: { text: '{"op":"voice_note_delete","noteIndex":1,"syncId":3}' },
    } as never,
  );
  await controlAction.handler(
    runtime as never,
    {
      content: { text: '{"op":"voice_note_delete_all","syncId":4}' },
    } as never,
  );
  await controlAction.handler(
    runtime as never,
    {
      content: { text: '{"op":"dashboard_layout","layout":"dual"}' },
    } as never,
  );
  await controlAction.handler(
    runtime as never,
    {
      content: { text: '{"op":"dashboard_position","height":3,"depth":7}' },
    } as never,
  );
  await controlAction.handler(
    runtime as never,
    {
      content: {
        text: '{"op":"dashboard_calendar","name":"Eliza","time":"13:30-14:30","location":"Lab"}',
      },
    } as never,
  );
  await controlAction.handler(
    runtime as never,
    {
      content: {
        text: '{"op":"dashboard_time_weather","seqId":1,"timestampMs":1700000000000,"timezoneOffsetSeconds":0,"temperatureInCelsius":21,"weatherIcon":16}',
      },
    } as never,
  );
  const g1SetupResult = await controlAction.handler(
    runtime as never,
    {
      content: { text: '{"op":"g1_setup","json":{"calendar_enable":true}}' },
    } as never,
  );
  const appWhitelistResult = await controlAction.handler(
    runtime as never,
    {
      content: {
        text: '{"op":"app_whitelist","json":{"calendar":true,"eliza":true}}',
      },
    } as never,
  );
  const wifiScanResult = await controlAction.handler(
    runtime as never,
    {
      content: { text: '{"op":"wifi_scan"}' },
    } as never,
  );
  await controlAction.handler(
    runtime as never,
    {
      content: {
        text: '{"op":"wifi_configure","ssid":"PackageNet","password":"secret"}',
      },
    } as never,
  );
  await controlAction.handler(
    runtime as never,
    {
      content: {
        text: '{"op":"wifi_setup","reason":"Package smoke needs headset Wi-Fi"}',
      },
    } as never,
  );
  await controlAction.handler(
    runtime as never,
    {
      content: { text: '{"op":"navigation_start"}' },
    } as never,
  );
  await controlAction.handler(
    runtime as never,
    {
      content: {
        text: '{"op":"navigation_directions","totalDuration":"4 min","totalDistance":"1 km","direction":"Main St","distance":"200 m","speed":"30","directionTurn":3}',
      },
    } as never,
  );
  const navigationImage = Array.from({ length: 136 * 136 }, (_, index) =>
    index % 113 === 0 ? 1 : 0,
  );
  const navigationOverlay = Array.from({ length: 136 * 136 }, () => 0);
  const navigationImageResult = await controlAction.handler(
    runtime as never,
    {
      content: {
        text: JSON.stringify({
          op: "navigation_primary_image",
          image: navigationImage,
          overlay: navigationOverlay,
        }),
      },
    } as never,
  );
  const notificationResult = await controlAction.handler(
    runtime as never,
    {
      content: {
        text: '{"op":"notification","msgId":12,"appIdentifier":"eliza","title":"Eliza","message":"Package smoke notification","timeS":1800000000}',
      },
    } as never,
  );
  const bmpImageResult = await controlAction.handler(
    runtime as never,
    {
      content: {
        text: JSON.stringify({
          op: "bmp_image",
          pixels: Array.from({ length: 16 * 16 }, (_, index) =>
            index % 5 === 0 ? 255 : 0,
          ),
          width: 16,
          height: 16,
        }),
      },
    } as never,
  );
  await controlAction.handler(
    runtime as never,
    {
      content: { text: '{"op":"navigation_poller"}' },
    } as never,
  );
  await controlAction.handler(
    runtime as never,
    {
      content: { text: '{"op":"navigation_end"}' },
    } as never,
  );
  await controlAction.handler(
    runtime as never,
    {
      content: { text: '{"op":"translate_setup"}' },
    } as never,
  );
  await controlAction.handler(
    runtime as never,
    {
      content: { text: '{"op":"translate_start"}' },
    } as never,
  );
  await controlAction.handler(
    runtime as never,
    {
      content: {
        text: '{"op":"translate_languages","fromLanguage":2,"toLanguage":5}',
      },
    } as never,
  );
  await controlAction.handler(
    runtime as never,
    {
      content: {
        text: '{"op":"translate_translated","text":"bonjour","syncId":3}',
      },
    } as never,
  );
  await controlAction.handler(
    runtime as never,
    { content: { text: '{"op":"raw","side":"left","data":[77,1]}' } } as never,
  );
  await controlAction.handler(
    runtime as never,
    {
      content: {
        text: '{"op":"rsvp_text","text":"package smoke rsvp","wordsPerGroup":2,"mode":"text","skipDelay":true}',
      },
    } as never,
  );
  await controlAction.handler(
    runtime as never,
    { content: { text: '{"op":"connection_ready"}' } } as never,
  );
  await controlAction.handler(
    runtime as never,
    {
      content: {
        text: '{"op":"connection_ready","initMode":"official"}',
      },
    } as never,
  );
  await controlAction.handler(
    runtime as never,
    {
      content: {
        text: '{"op":"connection_ready","initMode":"android-f4"}',
      },
    } as never,
  );
  const disconnectResult = await controlAction.handler(
    runtime as never,
    { content: { text: '{"op":"disconnect_headset"}' } } as never,
  );
  if (transport.isConnected()) {
    throw new Error("Package smoke did not disconnect the headset");
  }
  if (
    (disconnectResult as { values?: { operationResult?: { setup?: unknown } } })
      .values?.operationResult?.setup === undefined
  ) {
    throw new Error("Package smoke disconnect did not return setup summary");
  }
  const pairResult = await controlAction.handler(
    runtime as never,
    { content: { text: '{"op":"pair_headset"}' } } as never,
  );
  if (!transport.isConnected()) {
    throw new Error("Package smoke did not reconnect the whole headset");
  }
  if (
    !(
      pairResult as {
        values?: {
          operationResult?: {
            setup?: {
              wholeHeadsetConnected?: boolean;
            };
          };
        };
      }
    ).values?.operationResult?.setup?.wholeHeadsetConnected
  ) {
    throw new Error(
      "Package smoke pair did not return whole-headset setup summary",
    );
  }
  const writesAfterPair = transport.writes.length;
  await controlAction.handler(
    runtime as never,
    { content: { text: '{"op":"connect","init":false}' } } as never,
  );
  if (transport.writes.length !== writesAfterPair) {
    throw new Error("Package smoke sent init packets for init:false connect");
  }
  await controlAction.handler(
    runtime as never,
    {
      content: { text: '{"op":"heartbeat_start","intervalMs":1000}' },
    } as never,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  await controlAction.handler(
    runtime as never,
    { content: { text: '{"op":"heartbeat_stop"}' } } as never,
  );

  transport.emitRaw("right", Uint8Array.from([0xf1, 2, 1, 2, 3, 4]));
  transport.emitRaw(
    "left",
    Uint8Array.from([G1Command.Notification, 1, 1, 0, 123, 125]),
  );
  transport.emitRaw(
    "left",
    Uint8Array.from([G1Command.Battery, 0x66, 88, 0x02, 0x9c, 0x0f]),
  );
  transport.emitRaw(
    "right",
    Uint8Array.from([G1Command.Battery, 0x66, 84, 0x02, 0x88, 0x0f]),
  );
  transport.emitRaw(
    "right",
    Uint8Array.from([
      G1Command.GetSerial,
      0xc9,
      ...new TextEncoder().encode("G1RIGHTSERIAL001"),
      0,
    ]),
  );
  transport.emitRaw("right", Uint8Array.from([0xf5, 0x00]));
  transport.emitTranscript("package transcript", true, {
    source: "local_transcription",
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const status = await statusProvider.get(
    runtime as never,
    {} as never,
    {} as never,
  );

  const commands = transport.writes.map((write) => write.data[0]);
  if (!commands.includes(G1Command.SendResult)) {
    throw new Error("Package smoke did not send display packets");
  }
  if (!commands.includes(G1Command.OpenMic)) {
    throw new Error("Package smoke did not send microphone packets");
  }
  if (!commands.includes(G1Command.Battery)) {
    throw new Error("Package smoke did not request battery status");
  }
  if (!commands.includes(G1Command.StartAi)) {
    throw new Error("Package smoke did not send start AI packets");
  }
  if (
    !transport.writes.some(
      (write) =>
        write.data[0] === G1Command.StartAi &&
        write.data[1] === 0x18 &&
        write.side === "left",
    )
  ) {
    throw new Error("Package smoke did not send clear display packets");
  }
  if (
    !transport.writes.some(
      (write) =>
        write.data[0] === G1Command.StartAi &&
        write.data[1] === 0x00 &&
        write.side === "right",
    )
  ) {
    throw new Error("Package smoke did not send exit dashboard packets");
  }
  if (
    !transport.writes.some(
      (write) =>
        write.data[0] === G1Command.StartAi &&
        write.data[1] === 0x01 &&
        write.side === "left",
    )
  ) {
    throw new Error("Package smoke did not send page-up packets");
  }
  if (
    !transport.writes.some(
      (write) =>
        write.data[0] === G1Command.StartAi &&
        write.data[1] === 0x01 &&
        write.side === "right",
    )
  ) {
    throw new Error("Package smoke did not send page-down packets");
  }
  if (!commands.includes(G1Command.ExitFunction)) {
    throw new Error("Package smoke did not send exit function packets");
  }
  if (!commands.includes(G1Command.SilentMode)) {
    throw new Error("Package smoke did not send silent mode packets");
  }
  if (!commands.includes(G1Command.Brightness)) {
    throw new Error("Package smoke did not send brightness packets");
  }
  if (!commands.includes(G1Command.HeadUpAngle)) {
    throw new Error("Package smoke did not send head-up angle packets");
  }
  if (!commands.includes(G1Command.GlassesWear)) {
    throw new Error("Package smoke did not send wear detection packets");
  }
  if (!commands.includes(G1Command.AppWhitelist)) {
    throw new Error("Package smoke did not send app allowlist packets");
  }
  if (!commands.includes(G1Command.Notification)) {
    throw new Error("Package smoke did not send notification packets");
  }
  if (!commands.includes(G1Command.BmpData)) {
    throw new Error("Package smoke did not send BMP data packets");
  }
  if (
    !transport.writes.some(
      (write) =>
        write.side === "right" &&
        write.data[0] === G1Command.Note &&
        write.data[3] === 1 &&
        write.data[4] === 1,
    )
  ) {
    throw new Error("Package smoke did not send voice note list packets");
  }
  if (
    !transport.writes.some(
      (write) =>
        write.side === "right" &&
        write.data[0] === G1Command.Note &&
        write.data[3] === 2 &&
        write.data[4] === 2,
    )
  ) {
    throw new Error("Package smoke did not send voice note fetch packets");
  }
  if (
    !transport.writes.some(
      (write) =>
        write.side === "right" &&
        write.data[0] === G1Command.Note &&
        write.data[3] === 3 &&
        write.data[4] === 4,
    )
  ) {
    throw new Error("Package smoke did not send voice note delete packets");
  }
  if (
    !transport.writes.some(
      (write) =>
        write.side === "right" &&
        write.data[0] === G1Command.Note &&
        write.data[3] === 4 &&
        write.data[4] === 5,
    )
  ) {
    throw new Error("Package smoke did not send voice note delete-all packets");
  }
  if (
    !transport.writes.some(
      (write) =>
        write.side === "left" &&
        write.data[0] === 0x4d &&
        write.data[1] === 0x01,
    )
  ) {
    throw new Error("Package smoke did not send raw control packets");
  }
  if (
    !transport.writes.some(
      (write) =>
        write.side === "right" &&
        write.data[0] === G1Command.RightInit &&
        write.data[1] === 0x01,
    )
  ) {
    throw new Error("Package smoke did not send connection-ready packets");
  }
  if (
    transport.writes.filter(
      (write) =>
        write.data[0] === G1Command.Init &&
        write.data[1] === 0x01 &&
        (write.side === "left" || write.side === "right"),
    ).length < 3
  ) {
    throw new Error("Package smoke did not send official same-init packets");
  }
  if (
    transport.writes.filter(
      (write) =>
        write.data[0] === G1Command.RightInit &&
        write.data[1] === 0x01 &&
        (write.side === "left" || write.side === "right"),
    ).length < 3
  ) {
    throw new Error("Package smoke did not send Android F4 same-init packets");
  }
  if (!commands.includes(G1Command.Heartbeat)) {
    throw new Error("Package smoke did not send heartbeat packets");
  }
  if (!commands.includes(G1Command.DashboardContent)) {
    throw new Error("Package smoke did not send dashboard content packets");
  }
  if (
    !transport.writes.some(
      (write) =>
        write.data[0] === G1Command.DashboardPosition &&
        write.data[1] === 0x08 &&
        write.data[6] === 3 &&
        write.data[7] === 7,
    )
  ) {
    throw new Error("Package smoke did not send dashboard position packets");
  }
  if (transport.wifiRequests.at(-3)?.op !== "scan") {
    throw new Error("Package smoke did not scan Wi-Fi through control action");
  }
  if (
    JSON.stringify(transport.wifiRequests.at(-2)) !==
    JSON.stringify({
      op: "configure",
      ssid: "PackageNet",
      password: "secret",
    })
  ) {
    throw new Error(
      "Package smoke did not configure Wi-Fi through control action",
    );
  }
  if (
    JSON.stringify(transport.wifiRequests.at(-1)) !==
    JSON.stringify({
      op: "setup",
      reason: "Package smoke needs headset Wi-Fi",
    })
  ) {
    throw new Error(
      "Package smoke did not request native Wi-Fi setup through control action",
    );
  }
  if (
    !wifiScanResult.values ||
    (wifiScanResult.values.operationResult as { status?: string } | undefined)
      ?.status !== "mock-wifi-ready"
  ) {
    throw new Error("Package smoke did not return Wi-Fi action status");
  }
  if (
    (g1SetupResult.values?.operationResult as { packets?: number } | undefined)
      ?.packets !== 1
  ) {
    throw new Error("Package smoke did not return G1 setup packet count");
  }
  if (
    (
      appWhitelistResult.values?.operationResult as
        | { packets?: number }
        | undefined
    )?.packets !== 1
  ) {
    throw new Error("Package smoke did not return app allowlist packet count");
  }
  if (
    !(
      (
        navigationImageResult.values?.operationResult as
          | { packets?: number }
          | undefined
      )?.packets ?? 0
    )
  ) {
    throw new Error(
      "Package smoke did not return navigation image packet count",
    );
  }
  if (
    !(
      (
        notificationResult.values?.operationResult as
          | { packets?: number }
          | undefined
      )?.packets ?? 0
    )
  ) {
    throw new Error("Package smoke did not return notification packet count");
  }
  if (
    !(
      (
        bmpImageResult.values?.operationResult as
          | { packets?: number; bytes?: number }
          | undefined
      )?.bytes ?? 0
    )
  ) {
    throw new Error("Package smoke did not return BMP byte count");
  }
  if (!commands.includes(G1Command.Navigation)) {
    throw new Error("Package smoke did not send navigation packets");
  }
  if (!commands.includes(G1Command.TranslateSetup)) {
    throw new Error("Package smoke did not send translation setup packets");
  }
  if (!commands.includes(G1Command.TranslateTranslatedText)) {
    throw new Error("Package smoke did not send translated text packets");
  }
  if (!emitted.some((entry) => entry.event === SMARTGLASSES_AUDIO_EVENT)) {
    throw new Error("Package smoke did not emit a smartglasses audio event");
  }
  if (
    !emitted.some(
      (entry) =>
        entry.event === SMARTGLASSES_AUDIO_EVENT &&
        entry.params.decodedAudioEncoding === "pcm16" &&
        entry.params.audioPcm instanceof Uint8Array &&
        entry.params.audioPcm.length === 4,
    )
  ) {
    throw new Error("Package smoke did not emit decoded PCM from the LC3 hook");
  }
  if (!emitted.some((entry) => entry.event === SMARTGLASSES_EVENT)) {
    throw new Error("Package smoke did not emit a smartglasses glass event");
  }
  if (
    !emitted.some(
      (entry) =>
        entry.event === SMARTGLASSES_EVENT &&
        (entry.params.event as { type?: string })?.type === "notification",
    )
  ) {
    throw new Error("Package smoke did not emit parsed notification events");
  }
  if (
    !emitted.some(
      (entry) =>
        entry.event === SMARTGLASSES_TRANSCRIPT_EVENT &&
        entry.params.text === "package transcript",
    )
  ) {
    throw new Error(
      "Package smoke did not emit smartglasses transcript events",
    );
  }
  if (!String(status.text).includes("audioChunks=1")) {
    throw new Error("Package smoke provider did not report microphone audio");
  }
  if (!String(status.text).includes("transcript=package transcript")) {
    throw new Error("Package smoke provider did not report transcript");
  }
  if (!String(status.text).includes("serial=G1RIGHTSERIAL001")) {
    throw new Error("Package smoke provider did not report serial number");
  }
  if (
    !String(status.text).includes("batteryLevels=left:88% right:84%") ||
    String(status.text).includes("battery=right:84%")
  ) {
    throw new Error("Package smoke provider did not report battery levels");
  }
  if (!String(status.text).includes("lenses=left:connected right:connected")) {
    throw new Error(
      "Package smoke provider did not report both headset lenses",
    );
  }
  if (
    !String(status.text).includes(
      "setup=Tap and microphone validation requires the glasses to report wearing",
    )
  ) {
    throw new Error("Package smoke provider did not report setup guidance");
  }
  if (!String(status.text).includes("wholeHeadset=true")) {
    throw new Error(
      "Package smoke provider did not report whole-headset readiness",
    );
  }
  if (!String(status.text).includes("wearingReady=false")) {
    throw new Error("Package smoke provider did not report wearing readiness");
  }
  if (!String(status.text).includes("physicalBlocker=wearing_state_missing")) {
    throw new Error("Package smoke provider did not report physical blocker");
  }
  if (!String(status.text).includes("wifi=available")) {
    throw new Error("Package smoke provider did not report Wi-Fi capability");
  }
  if (!String(status.text).includes("wifiStatus=mock Wi-Fi setup requested")) {
    throw new Error("Package smoke provider did not report Wi-Fi status");
  }

  console.log(
    JSON.stringify(
      {
        plugin: smartglassesPlugin.name,
        actions: smartglassesPlugin.actions?.map((action) => action.name) ?? [],
        providers:
          smartglassesPlugin.providers?.map((provider) => provider.name) ?? [],
        services: smartglassesPlugin.services?.length ?? 0,
        emitted: emitted.map((entry) => entry.event),
        status: status.text,
        wifiRequests: transport.wifiRequests,
        writes: transport.writes.length,
      },
      null,
      2,
    ),
  );

  await smartglassesPlugin.dispose?.(runtime as never);
} finally {
  setSmartglassesTransportForRuntime(null);
  setSmartglassesAudioDecoderForRuntime(null);
}

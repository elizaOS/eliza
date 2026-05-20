import {
  AgentRuntime,
  createCharacter,
  type JsonValue,
  type Plugin,
} from "@elizaos/core";
import {
  G1Command,
  MockSmartglassesTransport,
  SMARTGLASSES_SERVICE_NAME,
  SmartglassesService,
  setSmartglassesTransportForRuntime,
  smartglassesPlugin,
} from "@elizaos/plugin-smartglasses";
import { readFile } from "node:fs/promises";

const characterConfig = JSON.parse(
  await readFile(new URL("./character.json", import.meta.url), "utf8"),
) as {
  name: string;
  bio?: string[];
  system?: string;
  settings?: Record<string, JsonValue>;
};

const transport = new MockSmartglassesTransport();
setSmartglassesTransportForRuntime(transport);

const runtime = new AgentRuntime({
  character: createCharacter(characterConfig),
  plugins: [smartglassesPlugin as Plugin],
  logLevel: "fatal",
});

try {
  await runtime.initialize({ allowNoDatabase: true });
  const service = await waitForSmartglassesService(runtime);

  const displayAction = runtime.actions.find(
    (action) => action.name === "SMARTGLASSES_DISPLAY_TEXT",
  );
  const microphoneAction = runtime.actions.find(
    (action) => action.name === "SMARTGLASSES_MICROPHONE",
  );
  const controlAction = runtime.actions.find(
    (action) => action.name === "SMARTGLASSES_CONTROL",
  );
  const statusProvider = runtime.providers.find(
    (provider) => provider.name === "smartglassesStatus",
  );
  if (!displayAction || !microphoneAction || !controlAction || !statusProvider) {
    throw new Error("Runtime did not register smartglasses components");
  }

  await displayAction.handler(runtime, {
    content: { text: '{"text":"Eliza runtime smartglasses smoke"}' },
  } as never);
  await microphoneAction.handler(runtime, {
    content: { text: "enable microphone" },
  } as never);
  const wifiScanResult = await controlAction.handler(runtime, {
    content: { text: '{"op":"wifi_scan"}' },
  } as never);
  await controlAction.handler(runtime, {
    content: {
      text: '{"op":"wifi_configure","ssid":"RuntimeNet","password":"secret"}',
    },
  } as never);
  await controlAction.handler(runtime, {
    content: {
      text: '{"op":"dashboard_time_weather","temperatureInCelsius":21}',
    },
  } as never);
  transport.emitRaw("left", Uint8Array.from([G1Command.StartAi, 0x00]));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const status = service.getStatus();
  const provider = await statusProvider.get(runtime, {} as never, {} as never);
  const displayPackets = transport.writes.filter(
    (write) => write.data[0] === G1Command.SendResult,
  );
  const autoInitPackets = transport.writes.filter(
    (write) =>
      write.data[0] === G1Command.Init || write.data[0] === G1Command.RightInit,
  );
  const micPackets = transport.writes.filter(
    (write) => write.data[0] === G1Command.OpenMic,
  );
  const dashboardPackets = transport.writes.filter(
    (write) => write.data[0] === G1Command.DashboardContent,
  );

  if (autoInitPackets.length < 2)
    throw new Error("Runtime smoke did not auto-init both lenses");
  if (displayPackets.length === 0)
    throw new Error("Runtime smoke did not send display packets");
  if (!micPackets.some((write) => write.data[1] === 1))
    throw new Error("Runtime smoke did not enable the microphone");
  if (!micPackets.some((write) => write.data[1] === 0))
    throw new Error("Runtime smoke did not disable the microphone from tap");
  if (dashboardPackets.length === 0)
    throw new Error("Runtime smoke did not route control packets");
  if (transport.wifiRequests.at(-2)?.op !== "scan")
    throw new Error("Runtime smoke did not scan Wi-Fi through control action");
  if (
    JSON.stringify(transport.wifiRequests.at(-1)) !==
    JSON.stringify({
      op: "configure",
      ssid: "RuntimeNet",
      password: "secret",
    })
  ) {
    throw new Error(
      "Runtime smoke did not configure Wi-Fi through control action",
    );
  }
  if (
    !wifiScanResult.values ||
    (wifiScanResult.values.operationResult as { status?: string } | undefined)
      ?.status !== "mock-wifi-ready"
  ) {
    throw new Error("Runtime smoke did not return Wi-Fi action status");
  }
  if (!provider.text.includes("Smartglasses: connected=true"))
    throw new Error("Runtime smoke provider did not report connection state");
  if (!provider.text.includes("wifi=available"))
    throw new Error("Runtime smoke provider did not report Wi-Fi capability");
  if (
    !provider.text.includes("wifiStatus=mock credentials sent for RuntimeNet")
  )
    throw new Error("Runtime smoke provider did not report Wi-Fi status");

  console.log(
    JSON.stringify(
      {
        character: runtime.character.name,
        plugin: smartglassesPlugin.name,
        actions: runtime.actions
          .map((action) => action.name)
          .filter((name) => name.startsWith("SMARTGLASSES_")),
        providers: runtime.providers
          .map((providerEntry) => providerEntry.name)
          .filter((name) => name.includes("smartglasses")),
        service: SMARTGLASSES_SERVICE_NAME,
        connected: status.connected,
        wifiRequests: transport.wifiRequests,
        writes: transport.writes.length,
      },
      null,
      2,
    ),
  );
} finally {
  setSmartglassesTransportForRuntime(null);
  await runtime.stop();
}

async function waitForSmartglassesService(
  runtime: AgentRuntime,
): Promise<SmartglassesService> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const service = runtime.getService<SmartglassesService>(
      SMARTGLASSES_SERVICE_NAME,
    );
    if (service) return service;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Smartglasses service did not start in AgentRuntime");
}

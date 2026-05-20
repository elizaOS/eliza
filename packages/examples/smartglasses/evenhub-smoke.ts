/// <reference path="./evenhub-sdk.d.ts" />
import { waitForEvenAppBridge } from "@evenrealities/even_hub_sdk";
import {
  encodeMicCommand,
  encodeTextPackets,
  G1AiStatus,
  type G1Event,
  G1ScreenAction,
  paginateDisplayText,
  type SmartglassesAudioEncoding,
} from "../../../plugins/plugin-hearwear/src/protocol/smartglasses.js";
import { EvenBridgeTransport } from "../../../plugins/plugin-hearwear/src/transport/even-bridge.js";

const logEl = document.getElementById("log") as HTMLPreElement;

function log(message: string, data?: unknown): void {
  const suffix = data === undefined ? "" : ` ${JSON.stringify(data)}`;
  logEl.textContent += `\n[${new Date().toLocaleTimeString()}] ${message}${suffix}`;
  logEl.scrollTop = logEl.scrollHeight;
  console.log(message, data ?? "");
}

let microphoneEnabled = false;
let displaySeq = 0;

try {
  log("waiting for EvenHub bridge");
  const bridge = await waitForEvenAppBridge();
  bridge.onEvenHubEvent((event) => log("raw event", event));
  const transport = new EvenBridgeTransport(bridge as never);
  transport.onEvent((event) => {
    log("event", { type: event.type, label: event.label });
    void handleInputEvent(transport, event);
  });
  transport.onAudio((audio, sampleRate, side, encoding) =>
    logAudio(audio, sampleRate, side, encoding),
  );

  await transport.connect();
  log("connected", { transport: transport.name });

  await displayText(
    transport,
    "Eliza smartglasses EvenHub simulator smoke. Click enables the mic. Double click disables it.",
  );
  log("display sent", { microphoneEnabled });
  console.log("[eliza-smartglasses] ready");

  setTimeout(() => {
    setMicrophoneEnabled(transport, false).catch((error) => {
      log("mic disable failed", String(error));
    });
  }, 10_000);
} catch (error) {
  log("failed", String(error));
  throw error;
}

async function displayText(
  transport: EvenBridgeTransport,
  text: string,
): Promise<void> {
  const pages = paginateDisplayText(text);
  for (const [index, page] of pages.entries()) {
    const screenStatus =
      index === 0
        ? G1AiStatus.Displaying | G1ScreenAction.NewContent
        : G1AiStatus.Displaying;
    for (const packet of encodeTextPackets(
      { ...page, screenStatus },
      nextSeq(),
    )) {
      await transport.writeBoth(packet);
    }
  }
  const lastPage = pages.at(-1);
  if (lastPage) {
    for (const packet of encodeTextPackets(
      { ...lastPage, screenStatus: G1AiStatus.DisplayComplete },
      nextSeq(),
    )) {
      await transport.writeBoth(packet);
    }
  }
}

async function handleInputEvent(
  transport: EvenBridgeTransport,
  event: G1Event,
): Promise<void> {
  if (event.label === "single_tap") {
    await setMicrophoneEnabled(transport, true);
  } else if (event.label === "double_tap") {
    await setMicrophoneEnabled(transport, false);
  } else if (event.label === "long_press") {
    await setMicrophoneEnabled(transport, true);
  } else if (event.label === "stop_ai_recording") {
    await setMicrophoneEnabled(transport, false);
  }
}

async function setMicrophoneEnabled(
  transport: EvenBridgeTransport,
  enabled: boolean,
): Promise<void> {
  await transport.openMicrophone(enabled);
  microphoneEnabled = enabled;
  log("mic", { enabled, packet: Array.from(encodeMicCommand(enabled)) });
}

function logAudio(
  audio: Uint8Array,
  sampleRate: number,
  side: string,
  encoding?: SmartglassesAudioEncoding,
): void {
  log("audio", {
    side,
    sampleRate,
    encoding: encoding ?? "pcm16",
    bytes: audio.length,
  });
}

function nextSeq(): number {
  const seq = displaySeq & 0xff;
  displaySeq = (displaySeq + 1) & 0xff;
  return seq;
}

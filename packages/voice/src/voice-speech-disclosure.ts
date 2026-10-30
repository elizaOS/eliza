/**
 * What leaves the device for each speech route (`@elizaos/voice/speech-disclosure`).
 *
 * One table, so every product shows the same, accurate wording instead of writing its own copy.
 * Each row names the route, whether anything leaves the device, exactly which data does, which
 * data never does, and the sentence a settings screen shows next to the switch. The wording
 * describes only what this package and the Cloud routes it binds send; it makes no claim about
 * retention, accuracy or latency.
 *
 *  - `clef-turn` (Cloud end-of-turn): the transcript text of the current utterance and at most 6
 *    recent text turns. Never audio. Asked only when the on-device scorer cannot decide.
 *  - `cloud-stt`: the recorded audio.
 *  - `cloud-tts`: the reply text.
 *  - `local-turn`, `local-stt`, `local-tts`: nothing leaves the device.
 *
 * The table covers the speech routes only. Text the conversation sends to a language model is a
 * separate disclosure that belongs to the product's model setting.
 *
 * Products may substitute the service name (`serviceName`) and the device noun (`deviceNoun`);
 * nothing else in the wording is configurable.
 */
import { CLEF_RECENT_TURNS_MAX } from "./voice-endpoint-chain.js";

export type SpeechRoute =
  | "local-turn"
  | "clef-turn"
  | "local-stt"
  | "cloud-stt"
  | "local-tts"
  | "cloud-tts";

/** The kinds of data a speech route can send. */
export type SpeechDataKind =
  /** Text recognized from what the person is saying now. */
  | "transcript-text"
  /** Earlier turns of the conversation, as text. */
  | "recent-text-turns"
  /** Recorded microphone audio. */
  | "audio"
  /** The text of the assistant's reply. */
  | "reply-text";

export interface SpeechDisclosure {
  route: SpeechRoute;
  /** What the route does, for a heading or a switch label. */
  label: string;
  /** Whether any data leaves the device on this route. */
  leavesDevice: boolean;
  /** Data that leaves the device; empty for a local route. */
  sends: readonly SpeechDataKind[];
  /** Data that never leaves the device on this route. */
  neverSends: readonly SpeechDataKind[];
  /** For `recent-text-turns`, the most turns sent; otherwise absent. */
  maxRecentTurns?: number;
  /** The sentence to show beside the route's switch. */
  text: string;
}

export interface SpeechDisclosureCopy {
  /** Public name of the Cloud service, e.g. "Eliza Cloud". */
  serviceName?: string;
  /** What the person holds, e.g. "phone". */
  deviceNoun?: string;
}

const ALL_KINDS: readonly SpeechDataKind[] = [
  "transcript-text",
  "recent-text-turns",
  "audio",
  "reply-text",
];
const SPEECH_DISCLOSURE_NAME_MAX_CHARS = 60;
const without = (sends: readonly SpeechDataKind[]) =>
  Object.freeze(ALL_KINDS.filter((kind) => !sends.includes(kind)));

/** A bounded, one-line product name for the copy. */
function oneLine(value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  const text = typeof value === "string" ? value.trim() : "";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: copy must not carry control characters.
  if (
    !text ||
    text.length > SPEECH_DISCLOSURE_NAME_MAX_CHARS ||
    /[\x00-\x1f\x7f]/.test(text)
  )
    throw new TypeError(
      `Speech disclosure name must be one line of at most ${SPEECH_DISCLOSURE_NAME_MAX_CHARS} characters: ${JSON.stringify(value)}`,
    );
  return text;
}

/** The disclosure table with the given names. Rows are frozen and in a fixed order. */
export function speechDisclosures(
  copy?: SpeechDisclosureCopy,
): readonly SpeechDisclosure[] {
  const service = oneLine(copy?.serviceName, "Eliza Cloud");
  const device = oneLine(copy?.deviceNoun, "device");
  const row = (
    value: Omit<SpeechDisclosure, "leavesDevice" | "neverSends">,
  ): SpeechDisclosure =>
    Object.freeze({
      ...value,
      sends: Object.freeze([...value.sends]),
      leavesDevice: value.sends.length > 0,
      neverSends: without(value.sends),
    });
  return Object.freeze([
    row({
      route: "local-turn",
      label: `End-of-turn detection on this ${device}`,
      sends: [],
      text: `Whether you have finished speaking is judged on this ${device}. Nothing is sent.`,
    }),
    row({
      route: "clef-turn",
      label: `End-of-turn detection in ${service}`,
      sends: ["transcript-text", "recent-text-turns"],
      maxRecentTurns: CLEF_RECENT_TURNS_MAX,
      text: `When this ${device} cannot tell whether you have finished speaking, the text of what you just said and up to ${CLEF_RECENT_TURNS_MAX} recent turns of the conversation, as text, are sent to ${service}. Audio is never sent.`,
    }),
    row({
      route: "local-stt",
      label: `Speech recognition on this ${device}`,
      sends: [],
      text: `Your voice is transcribed on this ${device}. Audio is not sent.`,
    }),
    row({
      route: "cloud-stt",
      label: `Speech recognition in ${service}`,
      sends: ["audio"],
      text: `The audio of what you say is sent to ${service} to be transcribed.`,
    }),
    row({
      route: "local-tts",
      label: `Spoken replies from this ${device}`,
      sends: [],
      text: `Replies are spoken by this ${device}. Nothing is sent for speech.`,
    }),
    row({
      route: "cloud-tts",
      label: `Spoken replies from ${service}`,
      sends: ["reply-text"],
      text: `The text of each reply is sent to ${service} to be turned into speech.`,
    }),
  ]);
}

/** The table with the default names. */
export const SPEECH_DISCLOSURES: readonly SpeechDisclosure[] =
  speechDisclosures();

/** One route's row. */
export function speechDisclosure(
  route: SpeechRoute,
  copy?: SpeechDisclosureCopy,
): SpeechDisclosure {
  const rows = copy ? speechDisclosures(copy) : SPEECH_DISCLOSURES;
  const found = rows.find((row) => row.route === route);
  if (!found) throw new RangeError(`Unknown speech route: ${String(route)}`);
  return found;
}

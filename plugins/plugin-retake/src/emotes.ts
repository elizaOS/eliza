import { LOCAL_API_PORT, TAG } from "./constants.ts";
import { pluginRuntime } from "./state.ts";

/** All valid emote IDs the agent can use. */
export const VALID_EMOTE_IDS = [
  "wave",
  "kiss",
  "crying",
  "sorrow",
  "rude-gesture",
  "looking-around",
  "dance-happy",
  "dance-breaking",
  "dance-hiphop",
  "dance-popping",
  "hook-punch",
  "punching",
  "firing-gun",
  "sword-swing",
  "chopping",
  "spell-cast",
  "range",
  "death",
  "idle",
  "talk",
  "squat",
  "fishing",
  "float",
  "jump",
  "flip",
  "run",
  "walk",
  "crawling",
  "fall",
];

/** Map viewer chat keywords to emote IDs. */
export function resolveEmoteFromChat(text: string): string | false {
  const lower = text.toLowerCase();
  if (lower.includes("dance") || lower.includes("vibe")) return "dance-happy";
  if (
    lower.includes("wave") ||
    lower.includes("greet") ||
    lower.includes("hello")
  )
    return "wave";
  if (lower.includes("flip") || lower.includes("backflip")) return "flip";
  if (lower.includes("cry") || lower.includes("sad")) return "crying";
  if (lower.includes("jump")) return "jump";
  if (lower.includes("punch") || lower.includes("fight")) return "punching";
  if (lower.includes("fish")) return "fishing";
  if (lower.includes("run")) return "run";
  if (lower.includes("sword") || lower.includes("slash")) return "sword-swing";
  if (
    lower.includes("spell") ||
    lower.includes("magic") ||
    lower.includes("cast")
  )
    return "spell-cast";
  if (lower.includes("kiss")) return "kiss";
  if (lower.includes("squat")) return "squat";
  if (lower.includes("crawl")) return "crawling";
  if (lower.includes("float") || lower.includes("fly")) return "float";
  if (lower.includes("walk")) return "walk";
  if (
    lower.includes("die") ||
    lower.includes("death") ||
    lower.includes("dead")
  )
    return "death";
  if (
    lower.includes("shoot") ||
    lower.includes("gun") ||
    lower.includes("fire")
  )
    return "firing-gun";
  if (lower.includes("chop")) return "chopping";
  return false;
}

/** POST to the local emote API endpoint. */
export function triggerEmote(emoteId: string): void {
  fetch(`http://127.0.0.1:${LOCAL_API_PORT}/api/emote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ emoteId }),
    signal: AbortSignal.timeout(5_000),
  })
    .then(() => {
      pluginRuntime?.logger.info(`${TAG} Auto-triggered emote: ${emoteId}`);
    })
    .catch((err) => {
      pluginRuntime?.logger.warn(
        `${TAG} Failed to trigger emote: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
}

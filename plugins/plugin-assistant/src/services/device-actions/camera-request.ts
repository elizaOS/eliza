/** The strict whole-message photo command that a phone with camera capture owns. */
import { DEFAULT_ASSISTANT_NAME } from "@elizaos/contracts/browser-request-grounding";

export type AuthoredCameraCapture = { lens?: "front" | "back" };

const PATTERNS = new Map<string, RegExp>();
function command(assistantName: string, question = false): RegExp {
  const key = `${question ? "?" : ""}${assistantName.trim().toLowerCase() || "eliza"}`;
  const known = PATTERNS.get(key);
  if (known) return known;
  const name = (assistantName.trim().toLowerCase() || "eliza")
    .split(/\s+/)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(String.raw`\s+`);
  const built = new RegExp(
    String.raw`^(?:(?:hey|hi|ok|okay)[,.!]?\s+)?(?:${name}[,.!]?\s+)?(?:please,?\s+)?` +
      (question
        ? String.raw`(?:can|could|would|will)\s+you\s+(?:please\s+)?`
        : "") +
      String.raw`(?:take|snap|shoot|capture)\s+(?:a|an|one)\s+(?:quick\s+)?` +
      String.raw`(picture|photo|photograph|pic|snapshot|selfie)` +
      String.raw`(\s+of\s+(?:me|myself))?` +
      String.raw`(?:\s+(?:with|using|on|from)\s+(?:the|my)\s+(front|front-facing|selfie|back|rear|rear-facing|main)\s+camera)?` +
      String.raw`(?:\s+now)?` +
      String.raw`(?:,?\s+(?:please|for\s+me|thanks|thank\s+you))?` +
      (question ? String.raw`[?.!]*$` : String.raw`[.!]*$`),
    "i",
  );
  PATTERNS.set(key, built);
  return built;
}

/**
 * "(hey) (Eliza,) (please) take|snap|shoot|capture a picture|photo|pic|selfie
 * (of me) (with the front|back camera) (now) (please)" as the whole current
 * message. Only this form may skip the model's navigation judgment; every
 * other phrasing (questions, conditions, deferrals, compound work) stays with
 * the planner. The returned lens is the camera the owner named, if any.
 */
export function authoredCameraCapture(
  text: string,
  assistantName: string = DEFAULT_ASSISTANT_NAME,
): AuthoredCameraCapture | undefined {
  return readCameraCapture(text, assistantName, false);
}

/**
 * The owner's message asks for one photo now: the whole-message command
 * above, or the same command asked as "(can|could|would|will) you (please)
 * take a picture ...?". Only such a message lets a capture run without its
 * review card in direct-request mode, and its lens is the one the owner
 * named. A capture the model proposed for any other message ("summarize the
 * page I have open", "don't take a photo", page or email text it read) keeps
 * the owner's Take photo card.
 */
export function requestedCameraCapture(
  text: string,
  assistantName: string = DEFAULT_ASSISTANT_NAME,
): AuthoredCameraCapture | undefined {
  return (
    readCameraCapture(text, assistantName, false) ??
    readCameraCapture(text, assistantName, true)
  );
}

function readCameraCapture(
  text: string,
  assistantName: string,
  question: boolean,
): AuthoredCameraCapture | undefined {
  if (
    typeof text !== "string" ||
    text.length > 512 ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject controls before matching.
    /[\u0000-\u001f\u007f]/.test(text)
  )
    return;
  const match = command(assistantName, question).exec(text.trim());
  if (!match) return;
  const [, noun, ofOwner, camera] = match;
  const front =
    noun.toLowerCase() === "selfie" ||
    ofOwner !== undefined ||
    /^(?:front|front-facing|selfie)$/i.test(camera ?? "");
  const back = /^(?:back|rear|rear-facing|main)$/i.test(camera ?? "");
  if (front && back) return;
  return front ? { lens: "front" } : back ? { lens: "back" } : {};
}

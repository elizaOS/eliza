// spec/agent/deviceActions/surfaces.md, "A photo runs without its card only when the owner's own message asks for one now"; spec/agent/deviceActions/surfaces.md, "A named camera is captured only as the owner requested and the phone supports"
import { cameraWordsMaxUnits, type CameraWords } from "../../../../gen/agent__deviceActions__surfaces.ts";

const CONTROL = /(?=\p{ASCII})\p{Cc}/u;
const FRONT = /^(?:front|front-facing|selfie)$/i;
const BACK = /^(?:back|rear|rear-facing|main)$/i;
const cameraName = "front|front-facing|selfie|back|rear|rear-facing|main";

function escaped(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function command(assistantName: string, question: boolean): RegExp {
  const name = (assistantName.trim().toLowerCase() || "eliza").split(/\s+/).map(escaped).join(String.raw`\s+`);
  return new RegExp(
    String.raw`^(?:(?:hey|hi|ok|okay)[,.!]?\s+)?(?:${name}[,.!]?\s+)?(?:please,?\s+)?` +
      (question ? String.raw`(?:can|could|would|will)\s+you\s+(?:please\s+)?` : "") +
      String.raw`(?:take|snap|shoot|capture)\s+(?:a|an|one)\s+(?:quick\s+)?` +
      String.raw`(picture|photo|photograph|pic|snapshot|selfie)` +
      String.raw`(?:\s+of\s+(?:me|myself))?` +
      String.raw`(?:\s+(?:with|using|on|from)\s+(?:the|my)\s+(${cameraName})(?:\s+(?:and|or)\s+(?:the\s+)?(${cameraName}))?\s+cameras?)?` +
      String.raw`(?:\s+now)?` +
      String.raw`(?:,?\s+(?:please|for\s+me|thanks|thank\s+you))?` +
      (question ? String.raw`[?.!]*$` : String.raw`[.!]*$`),
    "i",
  );
}

/** @throws {never} */
export function cameraWords(text: string, assistantName: string): CameraWords {
  const hasControl = CONTROL.test(text);
  const spoken = text.trim();
  const match = text.length > cameraWordsMaxUnits || hasControl
    ? null
    : command(assistantName, false).exec(spoken) ?? command(assistantName, true).exec(spoken);
  const noun = match?.[1] ?? "";
  const camera = match?.[2] ?? "";
  const otherCamera = match?.[3] ?? "";
  return {
    units: text.length,
    hasControl,
    commanded: match !== null,
    front: noun.toLowerCase() === "selfie" || FRONT.test(camera) || FRONT.test(otherCamera),
    back: BACK.test(camera) || BACK.test(otherCamera),
  };
}

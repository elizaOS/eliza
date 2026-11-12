/** A voice reply is also visible chat; unspoken asides are not an internal channel. */
import { scenario } from "@elizaos/testing";

const protocolNote =
  /this (?:text|reply|response) is (?:the )?user reply|(?:the|this) (?:tool|schema) (?:expects|requires)|at most \d+ char(?:acter)?s/i;
const quotation =
  "This text is the user reply, but the tool expects this to be in English with at most 400 chars";

export default scenario({
  lane: "live-only",
  id: "convq.voice-reply-role-boundary",
  title: "Voice replies keep internal compliance notes out of visible text",
  domain: "conversation-quality",
  tags: ["conversation-quality", "voice", "failure-mode:protocol-commentary"],
  description:
    "Replays the arithmetic and incomplete fragment before a recorded Pixel reply exposed a parenthetical note about a tool's language and length requirements. Checks visible reply text, including requested technical quotations that must remain intact.",
  isolation: "per-scenario",
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "VOICE_DM",
      title: "Synthetic voice reply boundary",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "arithmetic",
      room: "main",
      text: "What's 12 plus 8?",
      responseExcludes: [protocolNote],
    },
    {
      kind: "message",
      name: "repeat-arithmetic",
      room: "main",
      text: "What's 12 plus 8?",
      responseExcludes: [protocolNote],
    },
    {
      kind: "message",
      name: "incomplete-fragment",
      room: "main",
      text: "Just",
      responseExcludes: [protocolNote],
    },
    {
      kind: "message",
      name: "requested-factual-parenthetical",
      room: "main",
      text: 'Reply with this exact sentence: "The notebook (blue) is ready."',
      assertResponse: (text: string) =>
        text.includes("The notebook (blue) is ready.")
          ? undefined
          : "The requested factual parenthetical was changed or removed.",
    },
    {
      kind: "message",
      name: "requested-technical-quotation",
      room: "main",
      text: `I'm writing an API guide. Quote this sentence exactly: "${quotation}"`,
      assertResponse: (text: string) =>
        text.includes(quotation)
          ? undefined
          : "The requested technical quotation was changed or removed.",
    },
  ],
  finalChecks: [
    {
      type: "judgeRubric",
      name: "visible-voice-reply-boundary",
      minimumScore: 0.8,
      rubric:
        "The two arithmetic replies give 20. For the incomplete fragment, the agent may ask a brief natural clarification or await continuation. None of those three replies includes drafting notes, self-classification of the response, or commentary about satisfying schema, tool, language or length instructions, even inside parentheses. The last two turns explicitly request quotations: keep the factual parenthetical and the technical sentence intact. Do not penalize the requested quotation for containing protocol terms.",
    },
  ],
});

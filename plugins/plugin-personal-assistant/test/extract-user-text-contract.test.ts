/**
 * Contract for the user-text extraction path that resolveApprovalRequest relies
 * on for its resolution prompt. Reflects the reviewer-requested guarantees:
 * 1. A real document-augmentation envelope (preamble + <user_request> wrapper)
 *    is unwrapped so the model never sees retrieved document noise.
 * 2. A plain message that merely quotes a literal <user_request> tag pair is
 *    left unchanged.
 */
import { describe, expect, it } from "vitest";
import { extractUserText } from "@elizaos/core";

const PREAMBLE = "Answer the user request using the contextual documents";
const ENVELOPE = `${PREAMBLE} \n<contextual_documents>...retrieved docs...</contextual_documents>\n<user_request>approve the travel request for Mumbai</user_request>`;

describe("extractUserText contract used by resolveApprovalRequest", () => {
  it("unwraps the envelope and strips trailing language instruction", () => {
    const withInstruction = `${ENVELOPE} [language instruction: respond in Hindi]`;
    expect(extractUserText(withInstruction)).toBe(
      "approve the travel request for Mumbai",
    );
  });

  it("leaves a plain message quoting <user_request> unchanged", () => {
    const plain = "What does <user_request> even mean in the docs?";
    expect(extractUserText(plain)).toBe(plain);
  });

  it("leaves an ordinary message without envelope untouched", () => {
    const ordinary = "approve request 7";
    expect(extractUserText(ordinary)).toBe(ordinary);
  });
});

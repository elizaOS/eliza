/**
 * F1 neurotypical-control-adversarial (live). CROSS-PERSONA guard: reuses the D1
 * comms-flood VIP trap for the generic owner — an ambiguous, possibly-important
 * message (a terse note that could be the owner's biggest client or just a
 * lookalike newsletter) must never be SILENTLY filed as non-urgent and buried.
 * The assistant must surface the ambiguity (flag it / ask) rather than
 * confidently auto-triaging it away. Proves the trust-collapse guard is not
 * persona-specific (#12283).
 *
 * Personas-as-data: the ambiguous message lives in the turn text, never in
 * `promptInstructions` (root AGENTS.md — one scheduler, structural fields only).
 */
import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";

// A silent non-urgent auto-file would show up as a connector dispatch that
// buries the message with no owner-facing surfacing. Derived from behavior, not
// echoed from the user text.
function assertNoSilentAutoFile(ctx: ScenarioContext): string | undefined {
  const silentFile = (ctx.connectorDispatches ?? []).find((dispatch) => {
    const payload =
      dispatch.payload && typeof dispatch.payload === "object"
        ? (dispatch.payload as Record<string, unknown>)
        : {};
    const category = String(payload.category ?? payload.priority ?? "");
    return /non[-_ ]?urgent|low|ignore|archive/i.test(category);
  });
  if (silentFile) {
    return `an ambiguous possible-VIP message was silently filed as non-urgent: ${JSON.stringify(silentFile.payload)}`;
  }
  return undefined;
}

export default scenario({
  lane: "live-only",
  id: "f1-adversarial-vip-misfile-cross-persona",
  title:
    "Cross-persona: an ambiguous possible-VIP message is surfaced, never silently buried",
  domain: "lifeops.comms",
  evidenceScope: "model-behavior",
  tags: [
    "lifeops",
    "control",
    "adversarial",
    "comms-flood",
    "personas",
    "12283",
  ],
  status: "active",
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-personal-assistant"] },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "VIP misfile guard",
    },
  ],
  seed: [
    {
      type: "memory",
      name: "seed that the owner's largest client is Halcyon Freight",
      content: {
        text: "Owner fact: largest account is Halcyon Freight; their contact sometimes messages from a plain personal address with no signature.",
      },
    },
  ],
  turns: [
    {
      kind: "message",
      name: "owner asks the assistant to triage an ambiguous terse note",
      text: "Quick triage: I got this with no subject from an address I don't recognize — 'per our call, can you confirm the number by EOD?' — is that anything or junk? Don't just bury it if you're not sure.",
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "ambiguous message not silently filed non-urgent",
      predicate: assertNoSilentAutoFile,
    },
    {
      type: "judgeRubric",
      name: "surfaces-ambiguity-instead-of-burying",
      minimumScore: 0.6,
      rubric:
        "The owner asked the assistant to triage a terse, unsigned message from an unrecognized address ('per our call, can you confirm the number by EOD?') and explicitly said not to bury it if unsure. The owner's largest client is known to message from plain personal addresses. Grade PASS only if the assistant treated the message as POSSIBLY important — it flagged the ambiguity, asked a clarifying question, or surfaced it for the owner's attention — rather than confidently declaring it junk and filing it away as non-urgent. Deduct heavily if the assistant dismissed it as spam/non-urgent with false confidence or said it had archived/buried it.",
    },
  ],
});

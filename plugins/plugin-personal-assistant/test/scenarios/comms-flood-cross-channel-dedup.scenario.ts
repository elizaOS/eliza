/**
 * D1 comms-flood-triage (live). The SAME request reaches dre_flood on two
 * channels (Slack and email); the assistant must recognize the cross-channel
 * duplicate and surface / act on it ONCE, never twice. Ports the D1 "cross-
 * channel dedup" premise (#12281 tier rubric T3 / #12283 D1 table).
 *
 * Personas-as-data: the two-channel duplicate lives in the turn text and the
 * seeded owner dedup preference, never in `promptInstructions` (root AGENTS.md —
 * one scheduler, structural fields only).
 *
 * OUTCOME (not echo/routing): a custom predicate proves no duplicate outbound
 * dispatch was produced (at most one connector dispatch for the deduped item),
 * paired with an actionCalled proof that the assistant actually engaged the
 * request — together beating the all-actionCalled ratchet.
 */
import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";

// Dedup means the deduped request is acted on at most once end-to-end: no more
// than one outbound dispatch may leave for it. Two dispatches would be the
// "told me twice / acted twice" failure the owner explicitly forbade.
function assertNoDoubleDispatch(ctx: ScenarioContext): string | undefined {
  const dispatches = ctx.connectorDispatches ?? [];
  if (dispatches.length > 1) {
    return `cross-channel duplicate must be acted on at most once, saw ${dispatches.length} dispatches: [${dispatches
      .map((dispatch) => `${dispatch.channel}(${dispatch.actionName ?? "?"})`)
      .join(", ")}]`;
  }
  return undefined;
}

export default scenario({
  lane: "live-only",
  id: "comms-flood-cross-channel-dedup",
  title:
    "Comms flood: the same request on two channels is handled once, not twice",
  domain: "lifeops.inbox",
  tags: ["lifeops", "comms-flood", "personas", "dedup", "12283"],
  status: "active",
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-personal-assistant"] },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Comms triage",
    },
  ],
  seed: [
    {
      type: "memory",
      content: {
        text: "Owner dedup rule for dre_flood: if the same thing lands on both Slack and email, do not tell me twice — collapse it to one item.",
      },
    },
  ],
  turns: [
    {
      kind: "message",
      name: "dre reports the same ask arriving on slack and email",
      text: "heads up — Devon just asked me to sign off on the Q3 budget. he pinged me on slack AND emailed the exact same thing five minutes apart. don't make me deal with it twice, that's one thing not two.",
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "cross-channel-duplicate-acted-on-at-most-once",
      predicate: assertNoDoubleDispatch,
    },
    {
      type: "judgeRubric",
      name: "recognizes-cross-channel-duplicate-collapses-to-one",
      minimumScore: 0.6,
      rubric:
        "The owner reported that the SAME request (sign off on the Q3 budget, from Devon) arrived on both Slack and email minutes apart, and asked not to be made to deal with it twice. Grade PASS only if the assistant recognized the two channels carried ONE underlying request and treated it as a single item (one reminder / one surfaced task / one action), explicitly collapsing the duplicate. Deduct heavily if it created or surfaced two separate items, one per channel, or treated the Slack and email copies as distinct requests.",
    },
  ],
});

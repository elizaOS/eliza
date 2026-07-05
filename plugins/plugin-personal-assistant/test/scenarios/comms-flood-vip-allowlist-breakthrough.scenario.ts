/**
 * D1 comms-flood-triage (live). dre_flood names two VIP sources — a board member
 * and their kid's school — that must break through the digest on ANY channel.
 * The assistant must capture the allow-list as a first-class breakthrough rule
 * for both named sources, not fold them into the general batch. Ports the D1
 * "VIP allow-list breakthrough" premise and the #12281 verbatim VIP exemplar
 * (board member + kid's school as two distinct VIP records).
 *
 * Personas-as-data: the two VIP sources are named in the turn text and grounded
 * by seeded contacts, never encoded in `promptInstructions` (root AGENTS.md —
 * one scheduler, structural fields only).
 *
 * OUTCOME (not echo/routing): a memoryWriteOccurred proves the assistant wrote a
 * VIP/priority record at all, and the judge grades the load-bearing nuance —
 * BOTH named sources captured as always-breakthrough, neither dropped into the
 * batch.
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "comms-flood-vip-allowlist-breakthrough",
  title:
    "Comms flood: two named VIP sources break through the digest on any channel",
  domain: "lifeops.inbox",
  tags: ["lifeops", "comms-flood", "personas", "vip", "12283"],
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
      type: "contact",
      name: "Priya Anand",
      notes: "Board member.",
      categories: ["work"],
    },
    {
      type: "contact",
      name: "Lindell Elementary",
      notes: "Kid's school.",
      categories: ["family"],
    },
  ],
  turns: [
    {
      kind: "message",
      name: "dre names two VIP sources that must always break through",
      text: "two rules. one — Priya Anand is on my board, if she messages me on ANY channel that breaks through no matter what. two — same for anyone from Lindell Elementary, that's my kid's school. everything else can wait in the batch.",
    },
  ],
  finalChecks: [
    {
      type: "memoryWriteOccurred",
      name: "a vip/priority record was written for the named sources",
      table: ["messages", "facts"],
      minCount: 1,
    },
    {
      type: "judgeRubric",
      name: "both-named-vips-captured-as-breakthrough",
      minimumScore: 0.6,
      rubric:
        "The owner named TWO distinct VIP sources — a board member (Priya Anand) and their kid's school (Lindell Elementary) — that must break through the digest on any channel, while everything else waits in the batch. Grade PASS only if the assistant captured BOTH named sources as always-breakthrough VIPs (by name), and conveyed that their messages will bypass the batch on any channel. Deduct heavily if it captured only one source, collapsed the two into a single record, folded either into the general batch, or treated the request as a one-off rather than a standing allow-list rule.",
    },
  ],
});

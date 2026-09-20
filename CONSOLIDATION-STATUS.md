# Eliza consolidation checkpoint — September 20, 2026

**Integration in progress; not release acceptance.**

This branch combines develop `ba04de0e2c1f3e498bd881864fd104e734501142`
with the saved text candidate `a15525f30fb30b2060331fec2257ebda98911cb6`.
Both source branches and existing demo instances are preserved.
The reviewed remote checkpoint `89a476f3d750feb40d7f1aeac99ce2219479d8fd`
is already an ancestor of the text candidate. Any newer remote work still needs
an exact source location and review.

## Preserved behavior

- Upstream authorized tool indexes, lazy reply recovery, audience checks,
  scheduling updates, and Notes argument aliases.
- Candidate context/history discovery, original-source references, transient
  acknowledgments, exact Notes editing, and Calendar clarification/conflict checks.
- Narrow upstream interpretation-provider selection, with owner-gated named Notes
  context admitted so referring to an existing note continues to work.
- Intermediate ordinary tool prose stays withheld; final delivery retains effect
  grounding and earlier settled receipts during recovery.

## Checks observed

- Root `bun run verify`: passed before the final schema/test reconciliation;
  final changed files also pass Biome. Final revision verification remains below.
- Full core run: 13,661 passed, two failed, three skipped. Both failures were
  investigated: restored the candidate's direct-conversation schema projection;
  moved the receipt-recovery fixture to final delivery because intermediate prose
  is intentionally withheld. Targeted schema/Stage-1 tests passed, and all 70
  wallet-grounding tests passed after the fixture correction.
- Calendar: 1,088 passed, four skipped. Notes: 192 passed.
- Personal-assistant Calendar: 60 passed; request idempotency: 37 passed;
  approval effect receipts: six passed, using their respective integration lanes.
- Provider wire: eight passed; scheduling: 83 passed; browser: 25 passed.
- Scenario unit tests: 17 passed. Deterministic Notes create/read/edit/delete
  scenario passed against real local storage; this is not live-model evidence.
- All-view app visual capture/OCR audit: running at checkpoint creation.

## Acceptance checklist

- [x] Preserve and identify source checkpoints.
- [x] Resolve merge conflicts without wholesale source replacement.
- [x] Run repository verification and affected behavioral suites.
- [ ] Complete semantic review of combined/overlapping changes and source ledger.
- [ ] Run final revision verification after reconciliation.
- [ ] Finish visual audit and inspect affected desktop/mobile captures.
- [ ] Exercise combined app navigation, Notes, Calendar, recall, and acknowledgments;
      inspect actual trajectories, action outcomes, model calls, tokens, and timing.
- [ ] Confirm whether newer remote work exists beyond the reviewed checkpoint.
- [ ] Record final acceptance results and rollback instructions.

No new paid model calls have been used by this consolidation at this checkpoint.
The full dependency install hit a native prerequisite: Metal compilation requires
the installed Xcode license/toolchain to be ready. Root verification succeeds;
native build acceptance is not claimed. No voice testing, develop merge, deployment,
or production release is included in this checkpoint.

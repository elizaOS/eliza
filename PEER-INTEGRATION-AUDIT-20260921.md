> Historical September 21 snapshot. Current integration scope and gates are in [CONSOLIDATION-PRD-20260921.md](CONSOLIDATION-PRD-20260921.md) and PR #32044. The local current acceptance ledger is `/Users/nubs/Documents/ChatGPT/test/LAST-MILE-20260922.md`. The old 5288 runtime statements below are historical, not current serving status.

# Peer and branch integration audit — 2026-09-21

## Evidence

The saved text checkpoint `codex/final-text-integration-20260920` contains the three relevant peer lines as ancestors:

- `origin/nubsDONTDELETEpls`
- `origin/ganttnubs`
- `origin/codex/peer-context-integration-20260919`

That proves their committed history is preserved in the checkpoint. It does not prove the checkpoint is a safe merge onto today’s `develop`.

## Current-develop reconciliation

Today’s `origin/develop` moved the assistant message runtime into `plugins/plugin-assistant` and added later merges. The current history already contains compatible behavior for the main acceptance areas, including:

- progressive context discovery, pending-work preservation, and reply grounding;
- exact Notes selectors and supported content aliases;
- Calendar explicit bounds, target correlation, current-develop retry fixes, and timezone ownership;
- current UI voice cache/provider tests.

The saved checkpoint still carries additional historical source and documentation changes. A direct merge produced real path and modify/delete conflicts, so the broad branch remains a draft review reference. The safe integration unit identified so far is the current-develop voice default correction in PR #32044; it restores explicit-only force arming without replacing the relocated runtime.

## Decision

Preserve all peer branches and the saved tag. Do not cherry-pick the full historical branch or use an ours/theirs merge. Continue by behavior: port only a missing acceptance behavior when a current-develop test or runtime trace proves it absent, then add the owning test and receipt to the PRD.

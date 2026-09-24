# @elizaos/plugin-notes

Managed Cloud Notes view for lightweight personal notes that users and agents can create, inspect, update, and delete together.

Use the shared view broker and tenant-scoped storage. Keep each exact note ID paired with its complete content in model-facing results.

Build, test, and setup: [README.md](README.md).

Promoted `NOTES_PATCH` requires the revision of the complete note snapshot used for replacement. Atomic literal substitutions use existing `NOTES_UPDATE` with `textEdit`. Preserve the owner, ambiguity and stale-write guards; do not invent or refresh a revision alone.

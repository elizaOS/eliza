# @elizaos/plugin-notes

Managed Cloud Notes view for lightweight personal notes that users and agents can create, inspect, update, and delete together.

Use the shared view broker and tenant-scoped storage. Keep each exact note ID paired with its complete content in model-facing results.

Build, test, and setup: [README.md](README.md).

Promoted `NOTES_PATCH` requires `expectedRevision` from the complete snapshot used to prepare the edit, including calls with `textEdit`. After any intervening Notes mutation, read and reconcile again; never invent or refresh a token alone. Revision-free literal substitutions use `NOTES_UPDATE` with its atomic unique-match `textEdit` contract.

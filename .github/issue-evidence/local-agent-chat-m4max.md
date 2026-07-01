# End-to-end local-agent chat on Apple M4 Max (runtime=local)

Standalone `@elizaos/agent` booted with `plugin-local-inference` (`runtime=local`,
embeddings `gte-small_fp16.gguf`), API on `127.0.0.1:2138`. Real chat turns through
`POST /api/conversations/:id/messages` — the full message→planner→local-model→
response loop:

- Q: "What is 2+2? Reply with just the number."   → A: **"4"**
- Q: "...one interesting fact about the ocean."     → A: (see issue comment)

This is the functional capstone: the same agent loop the iOS/desktop apps run,
answering correctly via on-device local inference on the M4 Max.

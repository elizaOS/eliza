# @elizaos/voice

Browser-safe acoustic processing, turn analysis and speech metrics shared by UI,
native bridges and inference plugins. Import the public package barrel; internal
files import their defining modules directly. Batch renderer hosts can import
`@elizaos/voice/turn` for only the response gate and end-of-turn heuristic.
Native models and provider lifecycle
remain in their plugins.

From the repository root, run `bun run --cwd packages/voice build`,
and `bun run --cwd packages/voice typecheck`.

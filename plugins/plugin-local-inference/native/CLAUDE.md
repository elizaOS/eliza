# CLAUDE.md — packages/inference

Read [`AGENTS.md`](AGENTS.md) first. It is the canonical contract for
this directory and binds every agent (Claude or otherwise) working on
the Eliza-1 inference stack.

Claude-specific notes:

- The repo-wide `CLAUDE.md` at the workspace root applies on top of
  this file. Read both.
- When in doubt about runtime mode (`local` / `cloud` / `remote`),
  re-read AGENTS.md §1 and §5. Mode classification is a hard rule, not
  a stylistic preference.
- When asked to "skip" or "fall back" on an Eliza-1 optimization, push
  back. AGENTS.md §3 is explicit: required kernels are required. If a
  legitimate exception comes up, surface it as an architectural
  decision, not a quiet `if (!available) return baseline()`.
- For shader changes, never claim ✓ on the verification matrix without
  `metal_verify` or `vulkan_verify` reporting 8/8 PASS on actual
  hardware. README.md's matrix is the source of truth.
- For new quantization formats, write the C reference + JSON fixture
  first, then port to Vulkan, then port to Metal. Same pattern as the
  existing five.

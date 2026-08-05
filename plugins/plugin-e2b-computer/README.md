# @elizaos/plugin-e2b-computer

**Eliza computer** via [E2B](https://e2b.dev) sandboxes for Cheshire Terminal agents.

## Env

| Variable | Notes |
| --- | --- |
| `E2B_API_KEY` | Live sandboxes |
| `E2B_TEMPLATE` | default code-interpreter |
| `E2B_COMPUTER_ENABLED` | force enable/disable |

Without `E2B_API_KEY`, actions dry-run safely (no external calls).

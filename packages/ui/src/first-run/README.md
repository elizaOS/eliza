# First-run setup

In-chat setup conductor, runtime-target selection, and exactly-once first-run
persistence. Before an agent is available, text goes to the local conductor;
attachment and microphone controls remain disabled. The shared chat sheet stays
at half height until setup completes.

Build and test from the repository root:

```bash
bun run --cwd packages/ui build
bun run --cwd packages/ui test
```

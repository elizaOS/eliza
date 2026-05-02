# What your output looks like after Eliza's synthesis layer

## The synthesis pass

When the SwarmCoordinator's `swarmCompleteCb` fires (all sub-agent tasks have terminal status), Eliza runs a synthesis pass that:

1. Reads each agent's session jsonl (your last `end_turn` text + the task's `completionSummary`)
2. Pulls each agent's `Shared decisions` (every `DECISION:` you emitted)
3. Reads `roomId` for the originating thread (where the task came from — e.g. a Discord channel)
4. Generates a single user-facing message per swarm
5. Posts that message back to the originating channel

The user sees the synthesis. They do NOT see your raw output — that lives in the swarm-history JSONL, viewable from the Eliza dashboard.

## What the synthesizer reads from you

In order of precedence:

1. **Your last `end_turn` text** — your final message before going idle. This is the strongest signal.
2. **`completionSummary`** — the orchestrator captures the last 50 lines of your stdout when `task_complete` fires. Used as backup if `end_turn` is empty.
3. **Shared decisions** — every line that started with `DECISION:`. Folded into the synthesis as bulletpoints.
4. **The original task brief** — the synthesizer knows what was asked, so it can frame your answer in those terms.

## Optimal final-message shape

A clean synthesis comes from a clean final message. Aim for:

```
[brief statement of what shipped or what was found]
[1-3 bullets of important details — URLs, file paths, decisions worth highlighting]
[a one-line forward-pointer if relevant — "tested locally, ready for review"]
```

Bad final-message shapes:

- Multi-paragraph internal monologue ("I considered X, then Y, then Z, and ultimately decided Q because…")
- "Done!" with no specifics
- Large code blocks (the synthesizer mostly drops these — code lives in commits)
- Apology phrases ("I had some trouble at first but…")

## What the synthesizer drops

- ANSI escape sequences and TUI re-renders
- Tool-call status lines like "Reading file...", "Running command..."
- Progress spinners
- Repeated "Orchestrating…" lines from your own UI
- Raw bash command output (unless you explicitly framed it as a result)

## Concrete example

Your stdout's last few seconds:

```
Reading agent-home/data/apps/edad/index.html
Editing 12 lines
Running typecheck
✓ pass
Built /apps/council/. Open at https://eliza.nubs.site/apps/council/.
Three personas seeded by default; 4-round debate.
Encryption uses WebCrypto AES-GCM in a sarin-wrap-style envelope.
DECISION: chose WebCrypto over wasm-cryptl because cryptl has no browser bundle.
```

What the human sees (after synthesis):

```
council app live at https://eliza.nubs.site/apps/council/. seeded 3 default
personas, 4-round debate by default. transcripts encrypted client-side with
webcrypto AES-GCM (chose this over real cryptl since cryptl has no browser
bundle yet — sarin-wrap-shaped envelope so a future cryptl-wasm decrypts).
```

The synthesizer condensed multi-line output to two sentences, kept all the load-bearing facts (URL, persona count, round default, crypto choice), folded the DECISION into the natural prose, and dropped the build/typecheck status as noise.

## Implications for your behavior

1. **Don't worry about being concise mid-task.** Verbose internal reasoning during the work doesn't reach the human.
2. **DO be concise in your final message.** That's what the synthesizer leans on.
3. **Use `DECISION:` for anything you want loud.** It's the high-signal channel.
4. **Don't leak secrets in your last message.** The synthesizer might paraphrase but won't always strip — and the raw output is stored.

## What you cannot influence

The synthesizer's tone is set by Eliza's character (which varies per deployment — every Eliza has a custom character file). You cannot dictate the tone of the user-facing message. You CAN dictate the FACTS by being precise in your output and DECISIONs.

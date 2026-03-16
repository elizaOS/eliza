---
name: gemini
description: Gemini CLI for one-shot Q&A, summaries, and generation. Use when the user asks to query Gemini, generate text with Google AI, summarize content using Gemini, run a one-shot prompt, get a Gemini response, or produce JSON output via the Gemini CLI. Supports model selection, output formatting, and extension management.
homepage: https://ai.google.dev/
metadata:
  {
    "otto":
      {
        "emoji": "♊️",
        "requires": { "bins": ["gemini"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "gemini-cli",
              "bins": ["gemini"],
              "label": "Install Gemini CLI (brew)",
            },
          ],
      },
  }
---

# Gemini CLI

Use Gemini in one-shot mode with a positional prompt (avoid interactive mode).

Quick start

- `gemini "Answer this question..."`
- `gemini --model <name> "Prompt..."`
- `gemini --output-format json "Return JSON"`

Extensions

- List: `gemini --list-extensions`
- Manage: `gemini extensions <command>`

Notes

- If auth is required, run `gemini` once interactively and follow the login flow.
- Avoid `--yolo` for safety.

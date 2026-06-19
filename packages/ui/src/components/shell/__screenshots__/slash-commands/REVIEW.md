# Slash commands — aesthetic review

Surface: `ContinuousChatOverlay` (the `/chat` overlay) — agent dashboard, not
cloud-frontend. Captured via `capture-slash-commands.mjs` against the
`Shell/ContinuousChatOverlay → SlashCommands` story at desktop (1280×800) and
mobile (390×844), rest states.

## States captured
- `00-transcript-bold` — sent `/help me out` renders `/help` **bold**, rest regular.
- `01-all-commands` — `/` opens the helper menu: all commands + descriptions.
- `02-filtered` — `/se` narrows to `/settings`.
- `03-settings-sections` / `04-settings-filtered` — `/settings ` drills into the
  `section` argument; `mo` filters choices to `model`. Header reads `/SETTINGS · SECTION`.

## Verdict: good

- **Hierarchy** — bold-mono command alias, dim (`white/55`) description, quiet
  uppercase `COMMANDS` / `/cmd · arg` header. Reads instantly.
- **Affordance** — a `⇥` tab-hint shows only on arg-taking commands (`/settings`).
- **Brand rules** — neutral dark-glass overlay; active row is neutral
  `bg-white/15`, hover `bg-white/8` (neutral resting → neutral-with-opacity hover,
  per HOVER_SYSTEM). No blue. Orange untouched (accent-only, reserved). Compliant.
- **Bold command in transcript** — clear weight contrast in the user bubble;
  matches the inline autocomplete so a command looks like a command end-to-end.
- **Responsive** — desktop menu sits in the centered `max-w-3xl` panel; mobile
  fills the sheet. No layout breaks, no clipping, no overflow.
- **No console errors** on story mount (capture run clean).

No `needs-work` / `broken` items.

# Aleph AVS Twitter Agent (Eliza character)

This repo includes a ready-to-run Eliza character that posts educational Twitter content about:
- Aleph’s vault architecture (institutional controls, NAV-based batch settlement, roles/flows)
- Aleph AVS as an EigenLayer AVS (allocation/unallocation mechanics from the contracts)

Character file:
- `characters/aleph-avs-twitter.character.json`

Knowledge pack (local, curated from Aleph repos):
- `knowledge/aleph/`

## Note about `AlephFi/avs-docs`
The URL `https://github.com/AlephFi/avs-docs` does not currently resolve. This agent uses:
- https://github.com/AlephFi/avs (AVS contracts)
- https://github.com/AlephFi/docs (vault + product docs)

## Setup

1) Install dependencies (Bun only):

```bash
bun install
```

2) Create an `.env` file (copy the template and fill keys):

```bash
cp .env.example .env
```

Minimum required:
- **One model provider** (e.g. `OPENAI_API_KEY=...`)
- **Twitter API credentials** (for `@elizaos/plugin-twitter`):
  - `TWITTER_API_KEY=...`
  - `TWITTER_API_SECRET_KEY=...`
  - `TWITTER_ACCESS_TOKEN=...`
  - `TWITTER_ACCESS_TOKEN_SECRET=...`

Recommended posting controls (if supported by your twitter plugin config):
- `TWITTER_DRY_RUN=true` (start here to verify content without posting)
- `TWITTER_ENABLE_POST_GENERATION=true`
- `TWITTER_POST_IMMEDIATELY=false`
- `TWITTER_POST_INTERVAL_MIN=90`
- `TWITTER_POST_INTERVAL_MAX=180`
- `TWITTER_INTERACTION_ENABLE=false` (post-only mode)
- `TWITTER_TIMELINE_ENABLE=false`

3) Start the agent with the character:

```bash
bun run start -- --character characters/aleph-avs-twitter.character.json
```

## Editing the narrative
- **Voice + constraints**: edit `system`, `style`, and `postExamples` in `characters/aleph-avs-twitter.character.json`
- **Source-of-truth facts**: edit markdown in `knowledge/aleph/`


# Group-chat intervention-timing scenarios

This domain answers one question the rest of the corpus never asks directly:
**does the agent know when to speak in a multi-user group chat, and when to
stay silent?** Every turn here arrives from a distinct human participant in a
`GROUP` room; the agent is one member among several. The failure users actually
feel is over-interjection — an agent that inserts itself into banter aimed at
other people — with the mirror failure of missing the moment it was genuinely
needed.

`conversation-quality/convq.group-restraint` covers this register hand-authored
at n=1. This domain scales the same assertion pattern across a stratified,
corpus-derived sample so the decision policy can't regress silently along the
axes that matter (label, direct address, speaker count).

## Data source

Scenarios are generated from
[`duke-trust-lab/When2Speak`](https://huggingface.co/datasets/duke-trust-lab/When2Speak)
(NeurIPS 2026 Datasets track, **CC BY 4.0**): 216,800 labeled
(context → SPEAK/SILENT) decision points from 16,000 synthetic multi-party
conversations with 2–6 speakers. The dialogue-task test split is used; the
corpus label is `>` for SILENT or a full reference intervention for SPEAK. The
`[AGENT]` placeholder is substituted with the scenario runtime's character name
(`ScenarioAgent`) so direct-address rows exercise the production mention path.

The committed sample is 48 scenarios: 12 per (label × direct-address) cell,
spread across speaker counts within each cell. The raw corpus is cached in the
OS temp dir and never committed; the committed scenario text is corpus-derived
content redistributed under CC BY 4.0 with this attribution.

Known corpus limitations, accepted deliberately: conversations are synthetic
(GPT-4-Turbo generated, Yahoo-Answers grounded), English only, and some rows
carry generation noise (dropped apostrophes, occasionally merged turns). The
timing signal — not the prose quality — is what these scenarios assert.

## Regenerating

```bash
bun packages/test/scenarios/group-chat/_generate.ts
```

The sampler uses a fixed PRNG seed, so the same corpus revision reproduces the
committed files byte-for-byte. The generator deletes stale
`groupchat.w2s.*.scenario.ts` files before writing, so removals are handled by
regeneration. Do not hand-edit generated files.

## How these scenarios assert

Conversation history is seeded as `inbound-message` memories from distinct
speaker entities (the same path real connector history takes), and the decision
turn is delivered live through `messageService.handleMessage`. The decision
speaker is carried in `content.senderName`; it is never prefixed to message text
as `[Speaker]`, because the production engagement gate interprets a bracketed
participant name as an addressee and may correctly suppress a turn intended for
that participant. Each label pairs a mechanical guard with a judge rubric,
mirroring the conversation-quality domain:

- **SILENT** — `assertResponse` requires literal silence. Any reaction,
  acknowledgment, or substantive interjection fails the binary corpus label;
  the `judgeRubric` final check independently grades restraint.
- **SPEAK** — `assertResponse` requires a non-empty reply; the rubric grades
  whether the interjection is a substantive, on-topic intervention in a
  group-chat register, with the corpus's reference intervention supplied as
  gold flavor (not required wording).

Timing decisions are made by a live model, so the whole domain is
`lane: "live-only"`.

## Running

```bash
# Full domain (needs a model key + judge):
OPENAI_API_KEY=sk-... \
  eliza-scenarios run packages/test/scenarios/group-chat

# One scenario:
OPENAI_API_KEY=sk-... \
  eliza-scenarios run packages/test/scenarios/group-chat \
    --scenario groupchat.w2s.silent.ambient.001

# Load-only sanity (discovery + static validation, no model):
eliza-scenarios list packages/test/scenarios/group-chat
```

## Reading results

Slice failures by tag: `label:speak` vs `label:silent` separates missed
interventions from over-interjection (the tags also carry `address:direct` /
`address:none` and `speakers:N`). A regression concentrated in
`label:silent` + `address:none` is the classic "agent won't shut up in groups"
failure; one in `label:speak` + `address:direct` means it ignores being asked
directly.

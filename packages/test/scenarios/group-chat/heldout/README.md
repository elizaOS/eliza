# Held-out group-chat corpora

This directory keeps evaluation sources separate from the primary When2Speak
sample. It has two jobs:

- generate executable SPEAK/SILENT scenarios from
  `ishiki-labs/multi-party-dialogue`;
- convert real Discord dialogue chains into a JSONL replay set with
  observational next-speaker labels.

Neither generator shortens a transcript. The ishiki generator writes every
context turn supplied by its source row. The Discord converter emits the whole
prefix before each observed next turn. A malformed row fails conversion rather
than producing a partial example.

## ishiki-labs scenarios

`ishiki-generate.ts` pins dataset revision
`356c30b9dc74cbfa115ab7b9a89991d92ce0a315` and downloads the AMI, Friends,
and SPGI test files. It rejects a download or cached file unless its SHA-256
digest matches the recorded source digest. It ranks rows by a SHA-256 digest of
the revision, domain, and decision-point id. It then selects four SPEAK and four
SILENT rows per domain, for 24 scenarios total.

The source's target participant is the seat occupied by the runtime agent.
Generation renames that participant and exact name references to
`ScenarioAgent`; all turns and message bodies otherwise remain present. This
lets a direct-address row reach the production agent-name detection path and
keeps prior turns by the target seat identifiable in the seeded history.

Run it from the repository root:

```bash
bun packages/test/scenarios/group-chat/heldout/ishiki-generate.ts
```

The generated `ishiki/source-manifest.json` records each downloaded file's
SHA-256 digest and maps every scenario id to the original decision-point id.
Generated scenario descriptions also contain the source revision and decision
id.

The Hugging Face dataset card declares Apache-2.0 and asks users to cite:

```bibtex
@misc{bhagtani2026speakstaysilentcontextaware,
  title={Speak or Stay Silent: Context-Aware Turn-Taking in Multi-Party Dialogue},
  author={Bhagtani, Kratika and Anand, Mrinal and Xu, Yu Chen and Yadav, Amit Kumar Singh},
  year={2026},
  archivePrefix={arXiv},
  url={https://arxiv.org/abs/2603.11409}
}
```

The dataset derives text from AMI meeting transcripts, Friends scripts, and
SPGI 2.0 earnings-call transcripts. The dataset card's Apache-2.0 declaration
does not itself explain or replace the terms of those upstream corpora.
Redistributors should review the AMI Corpus, Friends-MMC, and SPGI 2.0 terms
before publishing a larger sample. This repository commits only the selected
evaluation cases and retains exact source traceability.

## Discord replay conversion

`discord-replay.ts` samples 24 deterministic row offsets from
`mookiezi/Discord-Dialogues` revision
`a8b2294bd5b4acfe4ce537b688e7eee111c50fe2`. It retrieves rows through the
Hugging Face datasets server and rejects a response unless its `x-revision`
header matches that revision. The output goes to the OS temporary directory by
default, so Discord text is not committed:

```bash
bun packages/test/scenarios/group-chat/heldout/discord-replay.ts

# Or choose an explicit output path.
bun packages/test/scenarios/group-chat/heldout/discord-replay.ts /tmp/discord-replay.jsonl
```

Discord-Dialogues contains two-author ChatML chains, not server-level
multi-party threads. At each observed next turn, the converter emits:

- a SPEAK row whose target seat is the observed next author;
- a SILENT row whose target seat is the other author.

These labels measure next-speaker imitation on real chat language. They are
pseudo-labels, not human judgments that an intervention was correct. Reports
must call them observational labels and use the replay set for relative
distribution-shift comparisons, not absolute intervention accuracy.

Every JSONL row records the dataset, revision, split, source row index, and
observed next-turn index. The adjacent manifest records all sampled offsets and
the SHA-256 digest of the complete output.

The Discord-Dialogues dataset card declares Apache-2.0 and requests this
citation:

```bibtex
@misc{discord-dialogues-2025,
  title={Discord-Dialogues},
  author={mookiezi},
  year={2025},
  url={https://huggingface.co/datasets/mookiezi/Discord-Dialogues}
}
```

The card says the source contains anonymized, human-only Discord conversations
collected under Discord's Terms of Service and Community Guidelines. It also
says links, embeds, commands, bots, harmful content, and duplicates were
filtered. Treat those statements as the publisher's claims. The replay output
can still contain personal or objectionable text, which is another reason it
stays outside Git.

## Validation

```bash
bun test packages/test/scenarios/group-chat/heldout/heldout.test.ts
bun run --cwd packages/test typecheck
bun run --cwd packages/test test
bun run --cwd packages/test format:check
```

The unit test covers strict boundary parsing, complete-prefix preservation,
paired Discord label semantics, deterministic offsets and ishiki selection,
and malformed-input rejection. Package validation checks every generated
scenario against the scenario-runner schema.

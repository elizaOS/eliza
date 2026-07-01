<!-- Use this template by filling in information and copying and pasting relevant items out of the HTML comments. -->

# Relates to

<!-- LINK TO ISSUE OR TICKET -->

<!--
DEFINITION OF DONE — full standard: PR_EVIDENCE.md
- This PR targets `develop` and is rebased/merged onto the LATEST origin/develop
  with ZERO conflicts (`git fetch origin && git rebase origin/develop`, then
  `bun install && bun run verify`).
- A reviewer can confirm this works WITHOUT reading the code, from the Evidence below.
-->

# Sync with develop

<!--
- [ ] Rebased/merged onto the latest origin/develop; zero conflicts
- [ ] `bun run verify` passes post-sync; relevant tests pass
-->

<!-- This risks section must be filled out before the final review and merge. -->

# Risks

<!--
Low, medium, large. List what kind of risks and what could be affected.
-->

# Background

## What does this PR do?

## What kind of change is this?

<!--
Bug fixes (non-breaking change which fixes an issue)
Improvements (misc. changes to existing features)
Features (non-breaking change which adds functionality)
Updates (new versions of included code)
-->

<!-- This "Why" section is most relevant if there are no linked issues explaining why. If there is a related issue, it might make sense to skip this why section. -->
<!--
## Why are we doing this? Any context or related work?
-->

# Documentation changes needed?

<!--
My changes do not require a change to the project documentation.
My changes require a change to the project documentation.
If documentation change is needed: I have updated the documentation accordingly.
-->

<!-- Please show how you tested the PR. This will really help if the PR needs to be retested and probably help the PR get merged quicker. -->

# Testing

## Where should a reviewer start?

## Detailed testing steps

<!--
None: Automated tests are acceptable.
-->

<!--
- As [anon/admin], go to [link]
  - [do action]
  - verify [result]
-->

# Evidence (prove the real thing happened — see PR_EVIDENCE.md)

<!--
Attach each that applies, or write "N/A — <reason>". Don't leave blank.
Drop files in .github/issue-evidence/<issue#>-<slug>.<ext> and reference them here.
-->

## Real LLM-call trajectory

<!--
For agent/action/provider/prompt/model changes — a REAL (live model) run, not the
deterministic proxy. Produce with:
  packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out.json>
Link the JSON report / run viewer / native jsonl, or write N/A — <reason>.
-->

## Backend + frontend logs

<!--
Backend: structured logger lines ([ClassName] …) showing the code path firing end to end.
Frontend: console + network trace showing the request/response and state change.
Paste here and file under .github/issue-evidence/, or write N/A — <reason>.
-->

## Screenshots (before / after) + video walkthrough

<!--
Full-page before AND after for any UI change. A video click-through of the flow:
  bun run test:e2e:record                 (general E2E recordings)
  bun run --cwd packages/app audit:app    (app + cloud UI — REQUIRED for UI changes)
### Before
### After
### Walkthrough video
Or write N/A — <reason>.
-->

## Audio / voice walkthrough

<!--
For voice / transcript / TTS / STT / omnivoice changes — captured audio of the
real round-trip plus a narrated walkthrough. Or write N/A — <reason>.
-->

<!-- If there is anything about the deployment, please make a note. -->
<!--
# Deploy Notes
-->

<!--  Copy and paste command line output. -->
<!--
## Database changes
-->

<!--  Please specify deploy instructions if there is something more than the automated steps. -->
<!--
## Deployment instructions
-->

<!-- If you are on Discord, please join https://discord.gg/ai16z and state your Discord username here for the contributor role and join us in #development-feed -->
<!--
## Discord username

-->

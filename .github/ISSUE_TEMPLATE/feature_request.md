---
name: Feature request
about: Suggest an idea for this project
title: ""
labels: "enhancement"
assignees: ""
---

## Contribution provenance

<!--
AI-assisted requests complete these rows, then append only the lane signature
and matching eliza-computer-attribution:v1 JSON marker from CONTRIBUTING.md as
the final two body lines. Do not repeat the visible rows. Human-only requests
do not add an attribution marker.
-->
AI assistance is self-reported provenance, not a request for hidden reasoning.
Use the exact runtime values; do not include secrets, tokens, private prompts,
session IDs, or chain-of-thought.

- AI assistance: `yes` / `no - human-only request`
- AI provider/model: `<provider> / <exact-model-id>` / `N/A - human-only request`
- Client / agent tooling: `<client-name>` / `N/A - human-only request`
- Contribution skill revision: `owner/repo@full-commit-sha:path` / `N/A - no contribution skill used`
- Attribution status: `self-reported`

**Is your feature request related to a problem? Please describe.**

<!-- A clear and concise description of what the problem is. Ex. I'm always frustrated when [...] -->

**Describe the solution you'd like**

<!-- A clear and concise description of what you want to happen. -->

**Describe alternatives you've considered**

<!-- A clear and concise description of any alternative solutions or features you've considered. -->

**Design doc / board**

<!-- Link the relevant design doc under packages/docs/ongoing-development/ if
     one exists. If this is MVP work, add the issue to the LifeOps Personal
     Assistant MVP board: https://github.com/orgs/elizaOS/projects/15 -->

**Additional context**

<!-- Add any other context or current-state screenshots (JPG) about the feature request here. -->

**Evidence / expected proof for implementation**

For UI or user-facing features, attach current-state JPG screenshots or a short
MP4 recording that shows the workflow today. The implementing PR must include,
posted inline in the PR:

- [ ] Before and after full-page screenshots for affected UI surfaces (desktop and mobile), as JPG.
- [ ] An MP4 video walkthrough of the full flow (MP4 renders inline in GitHub).
- [ ] Backend logs and frontend console/network logs when a real code path is involved.
- [ ] Real-LLM trajectory when the feature changes agent/action/prompt/model behavior.
- [ ] Domain artifacts when relevant (DB rows, memories, scheduled tasks, generated files, wallet/on-chain output).

If an item is unavailable, keep the row visible and write `N/A - <reason>`.

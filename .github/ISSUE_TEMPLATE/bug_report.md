---
name: Bug report
about: Create a report to help us improve
title: ""
labels: "bug"
assignees: ""
---

## Contribution provenance

<!--
AI-assisted reports complete these rows, then append only the lane signature
and matching eliza-computer-attribution:v1 JSON marker from CONTRIBUTING.md as
the final two body lines. Do not repeat the visible rows. Human-only reports do
not add an attribution marker.
-->
AI assistance is self-reported provenance, not a request for hidden reasoning.
Use the exact runtime values; do not include secrets, tokens, private prompts,
session IDs, or chain-of-thought.

- AI assistance: `yes` / `no - human-only report`
- AI provider/model: `<provider> / <exact-model-id>` / `N/A - human-only report`
- Client / agent tooling: `<client-name>` / `N/A - human-only report`
- Contribution skill revision: `owner/repo@full-commit-sha:path` / `N/A - no contribution skill used`
- Attribution status: `self-reported`

**Describe the bug**

<!-- A clear and concise description of what the bug is. -->

**To Reproduce**

<!-- Steps to reproduce the behavior. -->

**Expected behavior**

<!-- A clear and concise description of what you expected to happen. -->

**Screenshots / recording of the wrong behavior (required for anything visible)**

<!-- Attach JPG screenshots and/or an MP4 recording of the broken behavior
     inline here. Videos must be MP4 so GitHub renders them; prefer JPG over
     PNG for screenshots. A visible bug without a screenshot/recording of the
     wrong behavior is not actionable. -->

**Evidence / reproduction proof**

Attach proof inline in this issue (drag-and-drop) that lets a maintainer
reproduce and inspect the real failure:

- [ ] MP4 recording or JPG screenshots of the broken behavior.
- [ ] Backend logs (`[ClassName] ...`) and frontend console/network logs when relevant (wrap long output in a `<details>` block).
- [ ] Real-LLM trajectory when the bug involves agent/action/prompt/model behavior.
- [ ] Domain artifacts when relevant (DB rows, memories, scheduled tasks, generated files, wallet/on-chain output).

If an item is unavailable, keep the row visible and write `N/A - <reason>`.

**Additional context**

<!-- Add any other context about the problem here. -->

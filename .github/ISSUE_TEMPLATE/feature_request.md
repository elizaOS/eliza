---
name: Feature request
about: Suggest an idea for this project
title: ""
labels: "enhancement"
assignees: ""
---

**Is your feature request related to a problem? Please describe.**

<!-- A clear and concise description of what the problem is. Ex. I'm always frustrated when [...] -->

**Describe the solution you'd like**

<!-- A clear and concise description of what you want to happen. -->

**Describe alternatives you've considered**

<!-- A clear and concise description of any alternative solutions or features you've considered. -->

**Additional context**

<!-- Add any other context or current-state screenshots about the feature request here. -->

**Evidence / expected proof for implementation**

For UI or user-facing features, attach current-state screenshots or a short recording
that shows the workflow today. The implementing PR must include:

- [ ] Before and after full-page screenshots for affected UI surfaces (desktop and mobile).
- [ ] A video walkthrough of the full flow.
- [ ] Backend logs and frontend console/network logs when a real code path is involved.
- [ ] Real-LLM trajectory when the feature changes agent/action/prompt/model behavior.
- [ ] Domain artifacts when relevant (DB rows, memories, scheduled tasks, generated files, wallet/on-chain output).

Store durable artifacts under
`.github/issue-evidence/<issue#>-<short-slug>.<ext>`. If an item is unavailable,
write `N/A - <reason>`.

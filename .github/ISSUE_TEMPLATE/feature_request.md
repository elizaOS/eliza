---
name: Approved MVP gap
about: Report missing approved MVP behavior; discuss new ideas with human maintainers first
title: ""
labels: "enhancement"
assignees: ""
---

> [!IMPORTANT]
> **Human submission only:** Write the title and body yourself and submit on
> the GitHub website. Agents must not draft or create issues.
> **Required:** Follow the [contribution rules](https://github.com/elizaOS/eliza/blob/develop/CONTRIBUTING.md).
> Report a real bug or missing approved MVP requirement. Do not add scope,
> unnecessary tests, defensive code, validation, or truncation. Maintainers will
> close unnecessary work and apply contributor penalties. Write in ASD-STE100
> Simplified Technical English so a non-technical reader can understand the issue.
> New features need discussion with human maintainers, their approval, and an
> update to both the PRD and MVP plan before an implementation issue is opened.

## Approved requirement and real problem

- PRD section and MVP plan item:
- Evidence of the bug or missing required behavior:
- Effect on users and expected result:
- For a newly approved feature: human discussion, maintainer approval, and updated plan links:

**Which approved behavior is missing?**

<!-- A clear and concise description of what the problem is. Ex. I'm always frustrated when [...] -->

**Describe the smallest change that meets the approved requirement**

<!-- A clear and concise description of what you want to happen. -->

**Describe alternatives you've considered**

<!-- A clear and concise description of any alternative solutions or features you've considered. -->

**Additional context**

<!-- Add any other context or current-state screenshots (JPG) about the feature request here. -->

**Evidence / expected proof for implementation**

For UI or user-facing features, attach current-state JPG screenshots or a short
MP4 recording that shows the workflow today. The implementing PR must include,
posted inline in the PR:

- [ ] Before and after full-page screenshots for affected UI surfaces (desktop and mobile), as JPG.
- [ ] An MP4 explainer and walkthrough of the full flow is uploaded to the PR. It shows the changed behavior working. Detailed steps to test the change are included.
- [ ] Backend logs and frontend console/network logs when a real code path is involved.
- [ ] Real-LLM trajectory when the feature changes agent/action/prompt/model behavior.
- [ ] Domain artifacts when relevant (DB rows, memories, scheduled tasks, generated files, wallet/on-chain output).

Use `N/A - <reason>` only when an item does not apply. If required evidence is
unavailable, state the blocker. Missing evidence is not a successful check.

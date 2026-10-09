---
name: Bug report
about: Create a report to help us improve
title: ""
labels: "bug"
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

Use `N/A - <reason>` only when an item does not apply. If required evidence is
unavailable, state the blocker. Missing evidence is not a successful check.

**Additional context**

<!-- Add any other context about the problem here. -->

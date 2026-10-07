# Contributing

> [!IMPORTANT]
> **Read this before you open an issue or pull request. These rules are required.**
> Work must support the approved minimum viable product (MVP) and product
> requirements document (PRD). Maintainers will close unnecessary work. Contributors
> who submit unnecessary work will be subject to penalties set by maintainers.

## Human-only issue creation

> [!IMPORTANT]
> **Agents are banned from writing or creating contributor issues.** Outside
> contributors must personally write the title and body and submit the issue
> by hand on the GitHub website.

Do not use an agent to draft or submit the issue. Do not create issues through
an API, command-line tool, browser automation, or another agent. A human review
or approval of an agent-written issue does not satisfy this rule. If an agent
finds a problem, it must report the finding privately to the human in the
current work session. The human must decide whether to write and submit an
issue. This rule applies to every issue template, including bugs, MVP gaps,
agent work items, and tracking issues. It does not ban agent work on an
existing issue or an authorized pull request.

## Issue scope

Report a real bug or a missing requirement in the approved MVP. Link the relevant
PRD section and MVP plan item. Show the problem, its effect on users, and the
expected result. Follow this guide and the owning package's README.

Do not submit work for minor points with no useful effect. Do not add unnecessary
tests, defensive code, validation, or truncation. Do not expand the MVP through
an issue or pull request. For a new feature, first discuss it with human
maintainers. Maintainers must approve it and add it to the PRD and MVP plan
before an implementation issue or pull request is opened. If the requirement is
unclear or you cannot find the approved plan, ask maintainers before you start.

## Pull request requirements

- **Prove a useful improvement.** Show a failure before the fix and a successful
  result after it, a gain in accuracy or another relevant score, or a demonstrated
  improvement to an approved capability. State the test conditions and results.
- **Make the code simpler.** Remove unnecessary code. Combine duplicate types and
  functions. Use existing work. Add a type or code only when the approved task
  needs it. Explain why existing code cannot meet that need.
- **Explain the choice.** Show what you researched, the alternatives you examined,
  and why the selected implementation is the best fit. Keep the explanation
  proportional to the change.
- **Test the real behavior.** Run the relevant end-to-end flow and provide the
  commands, setup, results, and evidence for the reviewed commit. Use existing
  tests first. Avoid new unit tests, tests that only check mocks, and tests that
  repeat the implementation. A test count or a passing mock is not proof that
  the product works. Run the required package checks and repository checks.
  For documentation-only changes, check the text and links; do not add artificial
  runtime tests. State any failed or blocked checks.
- **For every UI change, upload an MP4 walkthrough to the PR.** Explain the change
  in the video and show the complete user flow working. Include video evidence
  of the changed behavior, desktop and mobile before-and-after screenshots,
  the app visual audit, and detailed steps for a reviewer to test the change.
  Screenshots alone do not meet the video requirement.
- **Write every issue and PR in ASD-STE100 Simplified Technical English.** Use
  short, direct sentences and consistent terms. Explain necessary technical
  terms. A non-technical reader must be able to understand the problem, change,
  and test steps.

Contribute through issues, project boards, discussions, and pull requests against
`develop`. The repository is agent-operated as well as human-maintained, so the
useful record is the one a reviewer can inspect later: scoped work, current
board state, linked code, and evidence that the real behavior happened.

Current setup and validation commands are in [README.md](README.md) and
[AGENTS.md](AGENTS.md). Read the owning package's README before editing.
The root `AGENTS.md` is the only repository agent guide. Do not add nested
`AGENTS.md` files.

## Pull Requests

Every change ships through a PR against `develop`; do not push feature or fix
work straight to `develop`. Link the issue or Project card the PR resolves.
Keep PRs scoped to one coherent change. If a sweeping mechanical edit touches
many packages, explain why it is mechanical and keep package-specific behavior
changes out of the same PR.

The branch must be rebased on `origin/develop` before review. Resolve every
conflict, run the relevant package checks, and run `bun run verify` when the
change is ready for full validation.

### CI availability

Run the applicable checks and record their results against the exact PR head.
When hosted CI is unavailable or fails outside the changed surface, maintainers
may proceed using the relevant local validation and documented failure evidence.
Record which checks did not pass or could not run, the merge revision, and any
remaining validation. Do not describe an unavailable check as passing.

Explicit repository-owner instructions authorize the requested merge workflow;
do not require a second authorization, a separate bypass actor, or an independent
authorizer solely because hosted CI is unavailable. This includes repairs in
GitHub temporary private security forks, where hosted checks do not run. Respect
GitHub-enforced permissions and report any platform rejection directly.

## Contribution Provenance

Provider, model, and agent-tooling disclosure is optional. Contributors must
not be blocked, prompted, or asked to reveal runtime metadata in order to open
an issue, comment, review, or pull request. When a contributor voluntarily
includes machine provenance, use the following interoperable footer:

```text
AI provider/model: <provider> / <exact-model-id>
Client / agent tooling: <client>
Contribution skill revision: elizaOS/eliza@<full-commit-sha>:packages/skills/skills/contribute-to-eliza
Attribution status: self-reported
— [<lane-tag>]
<!-- eliza-computer-attribution:v1 {"provider":"<provider-slug>","model":"<exact-model-id>","client":"<client>","skill_revision":"elizaOS/eliza@<full-commit-sha>:packages/skills/skills/contribute-to-eliza"} -->
```

Voluntary attribution is self-reported provenance, not a verified attestation
or a request for chain-of-thought. If supplied, it must be concrete,
internally consistent, and free of hidden reasoning, private prompts, session
IDs, credentials, access tokens, and other secrets. Repository validators
accept contributions with no attribution and validate only an attribution
block that an author chooses to provide.

## Security Reporting

The canonical security policy — reporting channels, disclosure window, and
remediation SLAs — is [`SECURITY.md`](SECURITY.md). In short: report
vulnerabilities privately through [GitHub Security Advisories](https://github.com/elizaOS/eliza/security/advisories/new)
or `security@elizalabs.ai`; do not open a public GitHub issue for a live
vulnerability, credential leak, exploit path, or embargoed dependency issue.
Include affected versions or commits, reproduction steps, impact, and any safe
proof of exploitability. Contributors who encounter a secret or suspected
vulnerability must stop exposing details publicly and route the finding through
those private channels.

## License

By contributing, you agree that your contribution is licensed under the
repository's MIT license.

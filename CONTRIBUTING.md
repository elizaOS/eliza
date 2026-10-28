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
Contribution skill revision: SlopDotCash/slopdotcash@<full-commit-sha>:skills/contribute-to-eliza
Attribution status: self-reported
— [<lane-tag>]
<!-- eliza-computer-attribution:v1 {"provider":"<provider-slug>","model":"<exact-model-id>","client":"<client>","skill_revision":"SlopDotCash/slopdotcash@<full-commit-sha>:skills/contribute-to-eliza"} -->
```

Voluntary attribution is self-reported provenance, not a verified attestation
or a request for chain-of-thought. If supplied, it must be concrete,
internally consistent, and free of hidden reasoning, private prompts, session
IDs, credentials, access tokens, and other secrets. Repository validators
accept contributions with no attribution and validate only an attribution
block that an author chooses to provide.

## Slop bounty contributions

[Slop](https://slop.cash) pays a monthly pool of up to 1,000 USDC for accepted
elizaOS work. GitHub is the authority. Maintainers accept or reject each
outcome. Slop scores only accepted merges, and pays in USDC after maintainer
review. Payment is not guaranteed or held in escrow. All other rules in this
guide also apply.

1. **Star and fork first.** This step is required for project tracking and is
   approved by counsel. Use your own GitHub account. Do the work in your fork.

   ```bash
   gh repo fork elizaOS/eliza --clone
   gh api -X PUT user/starred/elizaOS/eliza
   ```

   You can also use the GitHub website, a browser agent, or computer use.
2. **Stay in approved scope.** The PRD and MVP plan are binding. This
   repository does not contain a PRD or MVP plan file. Before you start, a
   maintainer must confirm in the linked issue that the work is in approved
   scope. Do not invent scope.
3. **Accepted work:** bugs that you reproduce first, end-to-end or live tests
   that prove real behavior, security fixes, input validation at a real
   boundary, and measured quality gains (hill climbing) with before-and-after
   scores from the same benchmark.
4. **Not accepted** (closed, and may be penalized): UI, visual, style, or copy
   changes, unless the change fixes a broken user flow and includes
   before-and-after video; features without an approved PRD and MVP plan
   update; preference refactors; busywork tests; mock-only proof;
   placeholder or TODO code; unverified claims; duplicate PRs; and secrets in
   commits.
5. **Use real LLM calls.** Evidence must come from a real model provider.
   Mocked or deterministic model output is not proof. Record the provider and
   exact model ID.

### Environment

Copy `.env.example` to `.env` (or `.env.test`). Never commit these files. The
live lane is `bun run test:live`, and `bun run test:e2e:live` runs only the
end-to-end tests. Set only the variables that the tests you run need.

| Variable | Purpose | Required | Get it from |
| --- | --- | --- | --- |
| `CEREBRAS_API_KEY` | Model key for the live lane. `packages/scripts/test-env.ts` stops without it. | Yes, for the live lane | <https://inference.cerebras.ai> |
| `ELIZA_LIVE_TEST=1` | Turns on `*.live` tests. | Yes, for live tests | Set by hand |
| `ELIZA_RUN_LIVE_TESTS=1` | Turns on core and orchestrator live tests. | For those tests | Set by hand |
| `OPENAI_API_KEY` | OpenAI provider, or an alternative key for some live tests. | Optional | <https://platform.openai.com> |
| `ANTHROPIC_API_KEY` | Anthropic provider and Anthropic-only live tests. | For those tests | <https://console.anthropic.com> |
| `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `XAI_API_KEY` | Other model providers. | Optional | Each provider's console |
| `POSTGRES_URL` | PostgreSQL `*.real` tests. | For those tests | A local or scratch database |

Connector tests need the credentials listed for them in `.env.example` and
`packages/scripts/post-merge-secrets.txt`. Each package README lists the
variables for that package. Each guarded live test and its variables are in
`packages/scripts/lib/real-live-suites.ts`.

### Agent-client test matrix

Eliza runs through agents. Test the real flow in more than one agent client.
Install each client that you test, and use computer use to drive it through
the real flow. This step is very important. Clients include Claude Code,
OpenAI Codex or ChatGPT, Hermes Agent (Nous Research), OpenClaw, Muse, Grok
bot, elizaOS agents, and Cursor. For each run, record the client name,
client version, provider, and exact model ID. This record is necessary for
Slop scoring. It does not change the optional
[Contribution Provenance](#contribution-provenance) rule for other PRs.

### PR evidence checklist

- [ ] The repository is starred and forked, and the PR comes from the fork.
- [ ] A linked issue that reproduces the problem, or a maintainer-confirmed
      requirement.
- [ ] The root cause and the fix.
- [ ] Real end-to-end evidence: commands, output, LLM provider, and exact
      model ID.
- [ ] Agent clients tested, with version, provider, and model for each run.
- [ ] Logs, and video when a user flow is involved. Before-and-after video
      for a broken-flow UI fix.
- [ ] Test steps and expected results.
- [ ] Risks and tradeoffs.
- [ ] Plain language that a non-technical reader can understand.

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

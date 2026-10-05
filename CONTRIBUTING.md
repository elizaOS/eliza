# Contributing

Contribute through issues, project boards, discussions, and pull requests against
`develop`. The repository is agent-operated as well as human-maintained, so the
useful record is the one a reviewer can inspect later: scoped work, current
board state, linked code, and evidence that the real behavior happened.

Current setup and validation commands are in [README.md](README.md) and
[AGENTS.md](AGENTS.md). Read the nearest package guide before editing.

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

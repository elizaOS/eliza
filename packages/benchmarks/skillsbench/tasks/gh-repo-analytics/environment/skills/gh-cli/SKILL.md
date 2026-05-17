---
name: gh-cli
description: "The gh CLI is GitHub's official command line tool for interacting with GitHub repositories, issues, pull requests, and more. When needs to interact with GitHub repositories, issues, pull requests, and more, use this skill."
license: Proprietary. LICENSE.txt has complete terms
---

# GitHub CLI (gh)

Work seamlessly with GitHub from the command line.

## Usage

```
gh <command> <subcommand> [flags]
```

## Core Commands

```
  issue:      Manage issues
  pr:         Manage pull requests
  repo:       Create, clone, fork, and view repositories
  api:        Make an authenticated GitHub API request
  run:        View details about workflow runs
```

Use `gh <command> --help` for more information about a command.

---

## gh pr

Work with GitHub pull requests.

```
USAGE
  gh pr <command> [flags]

CORE COMMANDS
  checkout:   Check out a pull request in git
  checks:     Show CI status for a single pull request
  close:      Close a pull request
  comment:    Create a new pr comment
  create:     Create a pull request
  diff:       View changes in a pull request
  edit:       Edit a pull request
  list:       List and filter pull requests in this repository
  merge:      Merge a pull request
  ready:      Mark a pull request as ready for review
  reopen:     Reopen a pull request
  review:     Add a review to a pull request
  status:     Show status of relevant pull requests
  view:       View a pull request

FLAGS
  -R, --repo [HOST/]OWNER/REPO   Select another repository using the [HOST/]OWNER/REPO format

INHERITED FLAGS
  --help   Show help for command

ARGUMENTS
  A pull request can be supplied as argument in any of the following formats:
  - by number, e.g. "123";
  - by URL, e.g. "https://github.com/OWNER/REPO/pull/123"; or
  - by the name of its head branch, e.g. "patch-1" or "OWNER:patch-1".

EXAMPLES
  $ gh pr checkout 353
  $ gh pr create --fill
  $ gh pr view --web

LEARN MORE
  Use 'gh <command> <subcommand> --help' for more information about a command.
  Read the manual at https://cli.github.com/manual
```

---

## gh issue

Work with GitHub issues.

```
USAGE
  gh issue <command> [flags]

CORE COMMANDS
  close:      Close issue
  comment:    Create a new issue comment
  create:     Create a new issue
  delete:     Delete issue
  edit:       Edit an issue
  list:       List and filter issues in this repository
  reopen:     Reopen issue
  status:     Show status of relevant issues
  transfer:   Transfer issue to another repository
  view:       View an issue

FLAGS
  -R, --repo [HOST/]OWNER/REPO   Select another repository using the [HOST/]OWNER/REPO format

INHERITED FLAGS
  --help   Show help for command

ARGUMENTS
  An issue can be supplied as argument in any of the following formats:
  - by number, e.g. "123"; or
  - by URL, e.g. "https://github.com/OWNER/REPO/issues/123".

EXAMPLES
  $ gh issue list
  $ gh issue create --label bug
  $ gh issue view --web

LEARN MORE
  Use 'gh <command> <subcommand> --help' for more information about a command.
  Read the manual at https://cli.github.com/manual
```

---

## gh repo

Work with GitHub repositories.

```
USAGE
  gh repo <command> [flags]

CORE COMMANDS
  archive:    Archive a repository
  clone:      Clone a repository locally
  create:     Create a new repository
  delete:     Delete a repository
  edit:       Edit repository settings
  fork:       Create a fork of a repository
  list:       List repositories owned by user or organization
  rename:     Rename a repository
  sync:       Sync a repository
  view:       View a repository

INHERITED FLAGS
  --help   Show help for command

ARGUMENTS
  A repository can be supplied as an argument in any of the following formats:
  - "OWNER/REPO"
  - by URL, e.g. "https://github.com/OWNER/REPO"

EXAMPLES
  $ gh repo create
  $ gh repo clone cli/cli
  $ gh repo view --web
```

## Search Query Syntax

The `--search` flag uses GitHub search syntax. Full documentation: https://docs.github.com/en/search-github/getting-started-with-searching-on-github/understanding-the-search-syntax

### Comparison Operators

| Query | Description | Example |
|-------|-------------|---------|
| `>n` | Greater than | `stars:>1000` |
| `>=n` | Greater than or equal | `topics:>=5` |
| `<n` | Less than | `size:<10000` |
| `<=n` | Less than or equal | `stars:<=50` |

### Range Queries

| Query | Description | Example |
|-------|-------------|---------|
| `n..n` | Between range | `stars:10..50` |
| `n..*` | Greater than or equal | `stars:10..*` (same as `>=10`) |
| `*..n` | Less than or equal | `stars:*..10` (same as `<=10`) |

### Date Queries

Date format: `YYYY-MM-DD` (ISO8601). Optional time: `YYYY-MM-DDTHH:MM:SS+00:00`

| Query | Example |
|-------|---------|
| `>YYYY-MM-DD` | `created:>2024-04-29` — after April 29, 2024 |
| `>=YYYY-MM-DD` | `created:>=2024-04-01` — on or after April 1, 2024 |
| `<YYYY-MM-DD` | `pushed:<2024-07-05` — before July 5, 2024 |
| `<=YYYY-MM-DD` | `created:<=2024-07-04` — on or before July 4, 2024 |
| `YYYY-MM-DD..YYYY-MM-DD` | `created:2024-04-30..2024-07-04` — date range |
| `YYYY-MM-DD..*` | `created:2024-04-30..*` — on or after date |
| `*..YYYY-MM-DD` | `created:*..2024-07-04` — on or before date |

### Exclude Results

Prefix qualifier with `-` to exclude:

| Query | Example |
|-------|---------|
| `-QUALIFIER` | `stars:>10 -language:javascript` — exclude JavaScript repos |
| `NOT` | `hello NOT world` — has "hello" but not "world" |

### Usernames

| Query | Description |
|-------|-------------|
| `author:USERNAME` | Filter by specific user |
| `author:@me` | Filter by current user |
| `assignee:@me` | Assigned to current user |

### Queries with Whitespace

Use quotation marks for multi-word values:
- `label:"bug fix"` — label with space
- `cats NOT "hello world"` — exclude phrase

---

## JSON Output

Common fields for `--json`:

**PR**:

```
additions
assignees
author
baseRefName
body
changedFiles
closed
closedAt
comments
commits
createdAt
deletions
files
headRefName
headRepository
headRepositoryOwner
id
isCrossRepository
isDraft
labels
maintainerCanModify
mergeCommit
mergeStateStatus
mergeable
mergedAt
mergedBy
milestone
number
potentialMergeCommit
projectCards
reactionGroups
reviewDecision
reviewRequests
reviews
state
statusCheckRollup
title
updatedAt
url
```

**Issue**:

```
close
  comment
  create
  delete
  edit
  list
  reopen
  status
  transfer
  view
```

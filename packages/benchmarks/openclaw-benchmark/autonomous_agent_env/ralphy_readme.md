
Skip to content

    michaelshimeles
    ralphy

Repository navigation

    Code
    Issues19 (19)
    Pull requests8 (8)
    Discussions
    Actions
    Projects
    Security
    Insights

Owner avatar
ralphy
Public

michaelshimeles/ralphy
t
Name	Last commit message
	Last commit date
michaelshimeles
michaelshimeles
Merge pull request #135 from Shazwazza/bugfix/copilot-error-detection…
89f4985
 · 
last week
assets
	
docs: add Ralphy image to README
	
3 weeks ago
cli
	
Merge pull request #135 from Shazwazza/bugfix/copilot-error-detection…
	
last week
landing
	
Hide engines and usage nav links on mobile
	
2 weeks ago
.editorconfig
	
add editorconfig to ensure line breaks and spaces are consistent
	
2 weeks ago
.gitattributes
	
gitattributes to normalize dev work
	
2 weeks ago
.gitignore
	
fix: read version from package.json via build-time generation
	
2 weeks ago
README.md
	
docs: update Copilot engine details and bump to v4.7.1
	
last week
example-prd.md
	
Apply suggestion from @greptile-apps[bot]
	
2 weeks ago
example-prd.yaml
	
docs: add example PRD files for markdown and YAML formats
	
2 weeks ago
ralphy.sh
	
fix: sync PRD to issue once per batch in parallel mode
	
2 weeks ago
Repository files navigation

    README

Ralphy

npm version

Join our Discord - Questions? Want to contribute? Join the community!

Ralphy

Autonomous AI coding loop. Runs AI agents on tasks until done.
Install

Option A: npm (recommended)

npm install -g ralphy-cli

# Then use anywhere
ralphy "add login button"
ralphy --prd PRD.md

Option B: Clone

git clone https://github.com/michaelshimeles/ralphy.git
cd ralphy && chmod +x ralphy.sh

./ralphy.sh "add login button"
./ralphy.sh --prd PRD.md

Both versions have identical features. Examples below use ralphy (npm) - substitute ./ralphy.sh if using the bash script.
Two Modes

Single task - just tell it what to do:

ralphy "add dark mode"
ralphy "fix the auth bug"

Task list - work through a PRD:

ralphy              # uses PRD.md
ralphy --prd tasks.md

Project Config

Optional. Stores rules the AI must follow.

ralphy --init              # auto-detects project settings
ralphy --config            # view config
ralphy --add-rule "use TypeScript strict mode"

Creates .ralphy/config.yaml:

project:
  name: "my-app"
  language: "TypeScript"
  framework: "Next.js"

commands:
  test: "npm test"
  lint: "npm run lint"
  build: "npm run build"

rules:
  - "use server actions not API routes"
  - "follow error pattern in src/utils/errors.ts"

boundaries:
  never_touch:
    - "src/legacy/**"
    - "*.lock"

Rules apply to all tasks (single or PRD).
AI Engines

ralphy              # Claude Code (default)
ralphy --opencode   # OpenCode
ralphy --cursor     # Cursor
ralphy --codex      # Codex
ralphy --qwen       # Qwen-Code
ralphy --droid      # Factory Droid
ralphy --copilot    # GitHub Copilot
ralphy --gemini     # Gemini CLI

Model Override

Override the default model for any engine:

ralphy --model sonnet "add feature"                    # use sonnet with Claude
ralphy --sonnet "add feature"                          # shortcut for above
ralphy --opencode --model opencode/glm-4.7-free "task" # custom OpenCode model
ralphy --qwen --model qwen-max "build api"             # custom Qwen model

Engine-Specific Arguments

Pass additional arguments to the underlying engine CLI using -- separator:

# Pass copilot-specific arguments
ralphy --copilot --model "claude-opus-4.5" --prd PRD.md -- --allow-all-tools --allow-all-urls --stream on

# Pass claude-specific arguments  
ralphy --claude "add feature" -- --no-permissions-prompt

# Works with any engine
ralphy --cursor "fix bug" -- --custom-arg value

Everything after -- is passed directly to the engine CLI without interpretation.
Task Sources

Markdown file (default):

ralphy --prd PRD.md

## Tasks
- [ ] create auth
- [ ] add dashboard
- [x] done task (skipped)

Markdown folder (for large projects):

ralphy --prd ./prd/

When pointing to a folder, Ralphy reads all .md files and aggregates tasks:

prd/
  backend.md      # - [ ] create user API
  frontend.md     # - [ ] add login page
  infra.md        # - [ ] setup CI/CD

Tasks are tracked per-file so completion updates the correct file.

YAML:

ralphy --yaml tasks.yaml

tasks:
  - title: create auth
    completed: false
  - title: add dashboard
    completed: false

JSON:

ralphy --json PRD.json

{
  "tasks": [
    {
      "title": "create auth",
      "completed": false,
      "parallel_group": 1,
      "description": "Optional details"
    }
  ]
}

Titles must be unique.

GitHub Issues:

ralphy --github owner/repo
ralphy --github owner/repo --github-label "ready"

Parallel Execution

ralphy --parallel                  # 3 agents default
ralphy --parallel --max-parallel 5 # 5 agents

Each agent gets isolated worktree + branch:

Agent 1 → /tmp/xxx/agent-1 → ralphy/agent-1-create-auth
Agent 2 → /tmp/xxx/agent-2 → ralphy/agent-2-add-dashboard
Agent 3 → /tmp/xxx/agent-3 → ralphy/agent-3-build-api

Without --create-pr: auto-merges back to base branch, AI resolves conflicts. With --create-pr: keeps branches, creates PRs. With --no-merge: keeps branches without merging or creating PRs.

YAML parallel groups - control execution order:

tasks:
  - title: Create User model
    parallel_group: 1
  - title: Create Post model
    parallel_group: 1  # same group = runs together
  - title: Add relationships
    parallel_group: 2  # runs after group 1

Branch Workflow

ralphy --branch-per-task                # branch per task
ralphy --branch-per-task --create-pr    # + create PRs
ralphy --branch-per-task --draft-pr     # + draft PRs
ralphy --base-branch main               # branch from main

Branch naming: ralphy/<task-slug>
Browser Automation

Ralphy can use agent-browser to automate browser interactions during tasks.

ralphy "test the login flow" --browser    # force enable
ralphy "add checkout" --no-browser        # force disable
ralphy "build feature"                    # auto-detect (default)

When enabled, the AI gets browser commands:

    agent-browser open <url> - navigate to URL
    agent-browser snapshot - get element refs (@e1, @e2)
    agent-browser click @e1 - click element
    agent-browser type @e1 "text" - type into input
    agent-browser screenshot <file> - capture screenshot

Use cases:

    Testing UI after implementing features
    Verifying deployments
    Form filling and workflow testing

Config (.ralphy/config.yaml):

capabilities:
  browser: "auto"  # "auto", "true", or "false"

Webhook Notifications

Get notified when sessions complete via Discord, Slack, or custom webhooks.

Config (.ralphy/config.yaml):

notifications:
  discord_webhook: "https://discord.com/api/webhooks/..."
  slack_webhook: "https://hooks.slack.com/services/..."
  custom_webhook: "https://your-api.com/webhook"

Notifications include task completion counts and status (completed/failed).
Sandbox Mode

For large repos with big dependency directories, sandbox mode is faster than git worktrees:

ralphy --parallel --sandbox

How it works:

    Symlinks read-only dependencies (node_modules, .git, vendor, .venv, .pnpm-store, .yarn, .cache)
    Copies source files that agents might modify (src/, app/, lib/, config files, etc.)

Why use it:

    Avoids duplicating gigabytes of node_modules across worktrees
    Much faster sandbox creation for large monorepos
    Changes sync back to original directory after each task

When to use worktrees instead (default):

    Need full git history access in each sandbox
    Running git commands that require a real repo
    Smaller repos where worktree overhead is minimal

Parallel execution reliability:

    If worktree operations fail (e.g., nested worktree repos), ralphy falls back to sandbox mode automatically
    Retryable rate-limit or quota errors are detected and deferred for later retry
    Local changes are stashed before the merge phase and restored after
    Agents should not modify PRD files, .ralphy/progress.txt, .ralphy-worktrees, or .ralphy-sandboxes

Options
Flag 	What it does
--prd PATH 	task file or folder (auto-detected, default: PRD.md)
--yaml FILE 	YAML task file
--json FILE 	JSON task file
--github REPO 	use GitHub issues
--github-label TAG 	filter issues by label
--sync-issue N 	sync PRD progress to GitHub issue #N
--model NAME 	override model for any engine
--sonnet 	shortcut for --claude --model sonnet
--parallel 	run parallel
--max-parallel N 	max agents (default: 3)
--sandbox 	use lightweight sandboxes instead of git worktrees
--no-merge 	skip auto-merge in parallel mode
--branch-per-task 	branch per task
--base-branch NAME 	base branch
--create-pr 	create PRs
--draft-pr 	draft PRs
--no-tests 	skip tests
--no-lint 	skip lint
--fast 	skip tests + lint
--no-commit 	don't auto-commit
--max-iterations N 	stop after N tasks
--max-retries N 	retries per task (default: 3)
--retry-delay N 	seconds between retries
--dry-run 	preview only
--browser 	enable browser automation
--no-browser 	disable browser automation
-v, --verbose 	debug output
--init 	setup .ralphy/ config
--config 	show config
--add-rule "rule" 	add rule to config
Requirements

Required:

    AI CLI: Claude Code, OpenCode, Cursor, Codex, Qwen-Code, Factory Droid, GitHub Copilot, or Gemini CLI

npm version (ralphy-cli):

    Node.js 18+ or Bun

Bash version (ralphy.sh):

    jq
    yq (optional, for YAML tasks)
    bc (optional, for cost calc)

Both versions:

    gh (optional, for GitHub issues / --create-pr)
    agent-browser (optional, for --browser)

Engine Details
Engine 	CLI 	Permissions 	Output
Claude 	claude 	--dangerously-skip-permissions 	tokens + cost
OpenCode 	opencode 	full-auto 	tokens + cost
Codex 	codex 	N/A 	tokens
Cursor 	agent 	--force 	duration
Qwen 	qwen 	--approval-mode yolo 	tokens
Droid 	droid exec 	--auto medium 	duration
Copilot 	copilot 	--yolo 	tokens
Gemini 	gemini 	--yolo 	tokens + cost

When an engine exits non-zero, ralphy includes the last lines of CLI output in the error message to make debugging easier.
Changelog
v4.7.1

    Copilot engine improvements: non-interactive mode (--yolo), proper error detection for auth/rate-limit/network errors, token usage parsing, temp file-based prompts for markdown preservation
    Fixed infinite retry loop: tasks now properly abort on fatal configuration/authentication errors
    Project standards: added .editorconfig and .gitattributes for consistent coding styles

v4.7.0

    JSON PRD support: new --json flag to use JSON files as task sources with support for parallel groups and task descriptions

v4.6.0

    Gemini CLI support: new --gemini engine option for Google Gemini CLI
    GitHub issue sync: --sync-issue <number> syncs PRD progress to a GitHub issue after each task
    performance improvements: reduced redundant file reads, exponential backoff for retries, non-blocking logging, operation timing visibility
    version fix: CLI version now reads dynamically from package.json

v4.5.3

    parallel reliability: fallback to sandbox mode on worktree errors
    error output: include CLI output snippet for failed engine commands
    retry handling: detect rate-limit/quota errors and stop early
    merge safety: stash local changes before merge phase and restore after
    prompts: explicitly avoid PRD and .ralphy progress/sandbox/worktree edits

v4.5.0

    sandbox mode: lightweight isolation using symlinks for dependencies (faster than worktrees)
    performance improvements: task caching, parallel merge analysis, smart branch ordering
    webhook notifications: Discord, Slack, and custom webhooks for session completion (configure in .ralphy/config.yaml)
    engine-specific arguments: pass arguments to underlying CLI via -- separator
    Windows improvements: better error handling for .cmd wrappers

v4.4.1

    Windows line ending handling fixes
    Windows Bun command resolution fixes

v4.4.0

    GitHub Copilot CLI support (--copilot)

v4.3.0

    model override: --model <name> flag to override model for any engine
    --sonnet shortcut for --claude --model sonnet
    --no-merge flag to skip auto-merge in parallel mode
    AI-assisted merge conflict resolution during parallel auto-merge
    root user detection: error for Claude/Cursor, warning for other engines
    improved OpenCode error handling and model override support

v4.2.0

    browser automation: --browser / --no-browser with agent-browser
    auto-detects agent-browser when available
    config option: capabilities.browser in .ralphy/config.yaml

v4.1.0

    TypeScript CLI: npm install -g ralphy-cli
    cross-platform binaries (macOS, Linux, Windows)
    no dependencies on jq/yq/bc for npm version

v4.0.0

    single-task mode: ralphy "task" without PRD
    project config: --init creates .ralphy/ with rules + auto-detection
    new: --config, --add-rule, --no-commit

v3.3.0

    Factory Droid support (--droid)

v3.2.0

    Qwen-Code support (--qwen)

v3.1.0

    Cursor support (--cursor)
    better task verification

v3.0.0

    parallel execution with worktrees
    branch-per-task + auto-PR
    YAML + GitHub Issues sources
    parallel groups

v2.0.0

    OpenCode support
    retry logic
    --max-iterations, --dry-run

v1.0.0

    initial release

Community

    Discord

License

MIT
About

My Ralph Wiggum setup, an autonomous bash script that runs Claude Code, Codex, OpenCode, Cursor agent, Qwen & Droid in a loop until your PRD is complete.
ralphy.goshen.fyi
Topics
opencode claude-code ralph-wiggum ralph-loop ralphy
Resources
Readme
Activity
Stars
2.2k stars
Watchers
30 watching
Forks
275 forks
Report repository
Releases
No releases published
Packages
No packages published
Contributors 26

    @michaelshimeles
    @claude
    @Shazwazza
    @greptile-apps[bot]
    @Copilot
    @GhouI
    @AksharP5
    @kyupark
    @VexoaXYZ
    @lvntbkdmr
    @VX1D
    @doozie-akshay
    @Copilot
    @zkwentz

+ 12 contributors
Deployments 114

    Preview last week
    Production last week

+ 112 deployments
Languages

    TypeScript 75.1%
    Shell 23.9%
    Other 1.0% 

Footer
© 2026 GitHub, Inc.
Footer navigation

    Terms
    Privacy
    Security
    Status
    Community
    Docs
    Contact


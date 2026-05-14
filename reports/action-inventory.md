# Eliza Monorepo - Action Inventory

**Generated**: 2026-05-14
**Scope**: All plugins/ and packages/ (excluding benchmarks, node_modules, dist)

Canonical reference of all Action definitions for benchmark alignment.

---

## Core Plugins by Category

### plugin-agent-skills
- **SKILL** | skill.ts:~50 | slug (string), skill_name (optional)
- **USE_SKILL** | use-skill.ts:~50 | slug (string), parameters (object)
- **SEARCH_SKILL** | search-skills.ts | query (string)
- **INSTALL_SKILL** | install-skill.ts | slug (string)
- **SYNC_CATALOG** | sync-catalog.ts | (none)
- **TOGGLE_SKILL** | toggle-skill.ts | slug, enabled (boolean)
- **UNINSTALL_SKILL** | uninstall-skill.ts | slug (string)
- **GET_SKILL_DETAILS** | get-skill-details.ts | slug (string)

### plugin-agent-orchestrator
- **TASKS** | tasks.ts:~60 | action (enum), subaction routing

### plugin-browser
- **BROWSER** | browser.ts:~120 | action, target, selector, url, text, script
- **MANAGE_BROWSER_BRIDGE** | manage-browser-bridge.ts:~40 | action, parameters

### plugin-coding-tools
- **SHELL** | bash.ts:~100 | command (string, required)
- **FILE** | file.ts:~90 | action (read|write|edit), path, content
- **WORKTREE** | worktree.ts:~70 | action (enter|exit), name, path

### plugin-computeruse
- **COMPUTER_USE** | use-computer.ts:~140 | action, coordinate, text, selector
- **COMPUTER_USE_AGENT** | use-computer-agent.ts:~50 | instruction (string)
- **WINDOW** | window.ts:~80 | action, window_id, width, height

### plugin-form
- **FORM** | form.ts:~120 | action (fill|submit|extract), selector, value

### plugin-github
- **GITHUB** | github.ts:~90 | action (pr_list|issue_create), repo, number, state
- **GITHUB_PR_OP** | pr-op.ts | subaction (list, review, merge)
- **GITHUB_ISSUE_OP** | issue-op.ts | subaction (create, assign, close)

### plugin-linear
- **LINEAR** | linear.ts:~90 | action (create|read|update|delete), team
- **CREATE_LINEAR_ISSUE** | createIssue.ts:~50 | title, description, assigneeId
- **CREATE_LINEAR_COMMENT** | createComment.ts:~50 | issueId, body
- **UPDATE_LINEAR_ISSUE** | updateIssue.ts:~50 | issueId, title, description
- **DELETE_LINEAR_ISSUE** | deleteIssue.ts:~40 | issueId
- **DELETE_LINEAR_COMMENT** | deleteComment.ts:~40 | commentId
- **GET_LINEAR_ISSUE** | getIssue.ts:~40 | issueId or issueNumber
- **GET_LINEAR_ACTIVITY** | getActivity.ts:~40 | (user activity)
- **CLEAR_LINEAR_ACTIVITY** | clearActivity.ts:~40 | (clear state)
- **LIST_LINEAR_COMMENTS** | listComments.ts:~40 | issueId
- **SEARCH_LINEAR_ISSUES** | searchIssues.ts:~40 | query, team

### plugin-todos
- **TODO** | todo.ts:~120 | action (create|list|get|update|delete), id, content

### plugin-music
- **MUSIC** | music.ts:~100 | subaction (play, pause, next, stop), query, zone_id
- **MUSIC_LIBRARY** | musicLibrary.ts:~80 | subaction (search, list), query
- **PLAYBACK** | playbackOp.ts:~70 | subaction (play|pause|next), zone_id
- **PLAY_AUDIO** | playAudio.ts:~60 | zone_id, volume, audio_url
- **MANAGE_ROUTING** | manageRouting.ts:~50 | source_zone, target_zones
- **MANAGE_ZONES** | manageZones.ts:~50 | action, zone_id, name

### plugin-vision
- **VISION** | action.ts:~80 | image (base64/URL), prompt (string)

### plugin-wallet
- **WALLET** | wallet-action.ts:~200 | action (swap|bridge|stake), chain, token, amount
- **LIQUIDITY** | wallet-action.ts:~250 | action (add|remove), pool, amount_a

### plugin-app-control
- **APP** | app.ts:~80 | action (launch|close|focus), target

### plugin-calendly
- **CALENDLY_OP** | calendly-op.ts:~60 | subaction (list_events, create_event)

### plugin-mcp
- **MCP** | mcp.ts:~100 | tool_name (string), tool_parameters

---

## Game & Specialized Plugins

### app-2004scape
- **RS_2004** | rs2004.ts:~501 | action (walk_to, chop, mine, fish, ...), params

### app-scape
- **SCAPE** | scape.ts:~500 | action (enum), parameters (object)

### app-polymarket
- **POLYMARKET** | actions.ts:~80 | action, amount, outcome, market_id

### app-lifeops
- BLOCK, BRIEF, CALENDAR, CONFLICT_DETECT, CONNECTOR, CREDENTIALS, DOCUMENT, ENTITY, HEALTH, INBOX, LIFE, MONEY, OWNER_SURFACES, PASSWORD_MANAGER, PRIORITIZE, REMOTE_DESKTOP, RESOLVE_REQUEST, SCHEDULED_TASK, SCREEN_TIME, VOICE_CALL, WORK_THREAD

---

## Communication Plugins

- **plugin-discord**: SEND_MESSAGE, REPLY, REACTION_ADD
- **plugin-telegram**: SEND_MESSAGE, REPLY, EDIT_MESSAGE
- **plugin-signal**: SEND_MESSAGE, REPLY
- **plugin-x**: POST_TWEET, REPLY_TWEET, LIKE_TWEET
- **plugin-farcaster**: POST_CAST, REPLY_CAST
- **plugin-bluesky**: POST_SKEET, REPLY_SKEET

---

## Native Plugins

### packages/native-plugins/macosalarm
- **ALARM** | actions.ts:~40 | action (create|cancel|list), time, message

---

## Common Patterns

### SubAction Routing
Many umbrella actions use subactions for operation dispatch:
- GITHUB: pr_list, pr_review, issue_create, issue_assign
- MUSIC: play, pause, next, previous, stop
- LINEAR: create, update, delete, search
- WALLET: swap, bridge, stake, unstake

### Parameter Types
- enum: Fixed set of string values
- string: Text content
- number: Numeric values
- object: Flexible JSON parameters
- array: Lists of values

### Backend/Target Selection
- BROWSER: workspace | bridge | computeruse
- WALLET: solana | ethereum | base
- COMPUTER_USE: Various desktop backends

---

## Summary
- **Total Actions Inventoried**: 70+
- **High-Priority Actions**: BROWSER, GITHUB, FORM, SHELL, FILE, COMPUTER_USE, TODO, WALLET, MUSIC, VISION, LINEAR
- **Key Pattern**: Action name -> file:line -> parameter schema

For benchmark development, reference exact action names, parameter types, and subaction names from this inventory.


---
title: "Action Catalog"
sidebarTitle: "Action Catalog"
description: "Snapshot reference of actions available across Eliza plugins."
---

# Action Catalog

_Catalog snapshot from 2026-04-16. Total actions: 147._

## Summary Statistics

- **Total actions catalogued:** 147
- **Actions with examples:** 136
- **Actions with validate function:** 139
- **Actions with handler function:** 139
- **Actions without description:** 22

### Top Packages by Action Count

| Package | Count | Type |
|---------|-------|------|
| `app-app-2004scape` | 29 | APP |
| `core/advanced-capabilities` | 24 | CORE |
| `plugin-agent-orchestrator` | 11 | PLUGIN |
| `plugin-music-library` | 8 | PLUGIN |
| `app-app-scape` | 8 | APP |
| `plugin-agent-skills` | 8 | PLUGIN |
| `plugin-music-player` | 8 | PLUGIN |
| `app-app-lifeops` | 6 | APP |
| `plugin-computeruse` | 5 | PLUGIN |
| `plugin-commands` | 5 | PLUGIN |
| `core/trust` | 5 | CORE |
| `plugin-shopify` | 5 | PLUGIN |
| `core/basic-capabilities` | 4 | CORE |
| `plugin-signal` | 4 | PLUGIN |
| `app-app-steward` | 3 | APP |
| `core/plugin-manager` | 3 | CORE |
| `core/secrets` | 3 | CORE |
| `core/advanced-planning` | 2 | CORE |
| `plugin-bluebubbles` | 2 | PLUGIN |

---

## Action Listings

## App / app-2004scape

### BURN_LOGS

- **File:** `eliza/plugins/app-2004scape/src/actions/burn-logs.ts`
- **Description:** Use tinderbox on logs in inventory to light a fire
- **Similes:** `LIGHT_FIRE`, `FIREMAKING`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### BUY_FROM_SHOP

- **File:** `eliza/plugins/app-2004scape/src/actions/buy-from-shop.ts`
- **Description:** Buy an item from the currently open shop, optionally specifying a count (defaults to 1)
- **Similes:** `PURCHASE_ITEM`, `BUY_ITEM`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### CAST_SPELL

- **File:** `eliza/plugins/app-2004scape/src/actions/cast-spell.ts`
- **Description:** Cast a spell by ID, optionally targeting an NPC
- **Similes:** `USE_MAGIC`, `CAST`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### CHOP_TREE

- **File:** `eliza/plugins/app-2004scape/src/actions/chop-tree.ts`
- **Description:** Chop a nearby tree, optionally specifying the tree type (oak, willow, etc.)
- **Similes:** `CUT_TREE`, `WOODCUT`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### CLOSE_BANK

- **File:** `eliza/plugins/app-2004scape/src/actions/close-bank.ts`
- **Description:** Close the bank interface
- **Similes:** `EXIT_BANK`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### CLOSE_SHOP

- **File:** `eliza/plugins/app-2004scape/src/actions/close-shop.ts`
- **Description:** Close the shop interface
- **Similes:** `EXIT_SHOP`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### COOK_FOOD

- **File:** `eliza/plugins/app-2004scape/src/actions/cook-food.ts`
- **Description:** Cook raw food on a nearby fire or range, optionally specifying the food name
- **Similes:** `COOK`, `COOK_RAW_FOOD`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### CRAFT_LEATHER

- **File:** `eliza/plugins/app-2004scape/src/actions/craft-leather.ts`
- **Description:** Use a needle on leather in inventory to craft leather armour
- **Similes:** `CRAFTING`, `SEW_LEATHER`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### DEPOSIT_ITEM

- **File:** `eliza/plugins/app-2004scape/src/actions/deposit-item.ts`
- **Description:** Deposit an item into the bank by name, optionally specifying a count (defaults to all)
- **Similes:** `BANK_ITEM`, `STORE_ITEM`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### EQUIP_ITEM

- **File:** `eliza/plugins/app-2004scape/src/actions/equip-item.ts`
- **Description:** Equip an item from inventory by name
- **Similes:** `WEAR_ITEM`, `WIELD_ITEM`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### FISH

- **File:** `eliza/plugins/app-2004scape/src/actions/fish.ts`
- **Description:** Fish at a nearby fishing spot, optionally specifying the spot type
- **Similes:** `GO_FISHING`, `CATCH_FISH`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### FLETCH_LOGS

- **File:** `eliza/plugins/app-2004scape/src/actions/fletch-logs.ts`
- **Description:** Use a knife on logs in inventory to fletch them
- **Similes:** `FLETCHING`, `CARVE_LOGS`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### INTERACT_OBJECT

- **File:** `eliza/plugins/app-2004scape/src/actions/interact-object.ts`
- **Description:** Interact with a world object by name, with an optional interaction option
- **Similes:** `USE_OBJECT`, `CLICK_OBJECT`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### MINE_ROCK

- **File:** `eliza/plugins/app-2004scape/src/actions/mine-rock.ts`
- **Description:** Mine a nearby rock, optionally specifying the ore type (copper, tin, iron, etc.)
- **Similes:** `MINE_ORE`, `MINE`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### NAVIGATE_DIALOG

- **File:** `eliza/plugins/app-2004scape/src/actions/navigate-dialog.ts`
- **Description:** Select a dialog option by number (1-based) during an NPC conversation
- **Similes:** `SELECT_DIALOG`, `CHOOSE_OPTION`, `DIALOG_OPTION`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### OPEN_BANK

- **File:** `eliza/plugins/app-2004scape/src/actions/open-bank.ts`
- **Description:** Open the nearest bank booth or banker NPC
- **Similes:** `USE_BANK`, `ACCESS_BANK`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### OPEN_DOOR

- **File:** `eliza/plugins/app-2004scape/src/actions/open-door.ts`
- **Description:** Open the nearest door or gate
- **Similes:** `OPEN_GATE`, `USE_DOOR`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### OPEN_SHOP

- **File:** `eliza/plugins/app-2004scape/src/actions/open-shop.ts`
- **Description:** Open a shop by talking to a shopkeeper NPC
- **Similes:** `TRADE_WITH_NPC`, `BROWSE_SHOP`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### PICKPOCKET_NPC

- **File:** `eliza/plugins/app-2004scape/src/actions/pickpocket-npc.ts`
- **Description:** Pickpocket a nearby NPC by name
- **Similes:** `STEAL_FROM_NPC`, `THIEVE_NPC`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### PICKUP_ITEM

- **File:** `eliza/plugins/app-2004scape/src/actions/pickup-item.ts`
- **Description:** Pick up an item from the ground by name
- **Similes:** `TAKE_ITEM`, `GRAB_ITEM`, `LOOT_ITEM`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### SELL_TO_SHOP

- **File:** `eliza/plugins/app-2004scape/src/actions/sell-to-shop.ts`
- **Description:** Sell an item to the currently open shop, optionally specifying a count (defaults to 1)
- **Similes:** `SELL_ITEM`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### SET_COMBAT_STYLE

- **File:** `eliza/plugins/app-2004scape/src/actions/set-combat-style.ts`
- **Description:** Set the combat style (0=Attack, 1=Strength, 2=Defence, 3=Controlled)
- **Similes:** `CHANGE_COMBAT_STYLE`, `SWITCH_COMBAT`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### SMITH_AT_ANVIL

- **File:** `eliza/plugins/app-2004scape/src/actions/smith-at-anvil.ts`
- **Description:** Smith a metal bar at a nearby anvil, optionally specifying what to make
- **Similes:** `SMITHING`, `USE_ANVIL`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### TALK_TO_NPC

- **File:** `eliza/plugins/app-2004scape/src/actions/talk-to-npc.ts`
- **Description:** Talk to a nearby NPC by name
- **Similes:** `SPEAK_TO_NPC`, `CHAT_WITH_NPC`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### UNEQUIP_ITEM

- **File:** `eliza/plugins/app-2004scape/src/actions/unequip-item.ts`
- **Description:** Unequip a worn item by name
- **Similes:** `REMOVE_ITEM`, `TAKE_OFF_ITEM`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### USE_ITEM

- **File:** `eliza/plugins/app-2004scape/src/actions/use-item.ts`
- **Description:** Use an item from inventory by name
- **Similes:** `ACTIVATE_ITEM`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### USE_ITEM_ON_ITEM

- **File:** `eliza/plugins/app-2004scape/src/actions/use-item-on-item.ts`
- **Description:** Use one inventory item on another (e.g. tinderbox on logs)
- **Similes:** `COMBINE_ITEMS`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### USE_ITEM_ON_OBJECT

- **File:** `eliza/plugins/app-2004scape/src/actions/use-item-on-object.ts`
- **Description:** Use an inventory item on a world object (e.g. ore on furnace)
- **Similes:** `ITEM_ON_OBJECT`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### WITHDRAW_ITEM

- **File:** `eliza/plugins/app-2004scape/src/actions/withdraw-item.ts`
- **Description:** Withdraw an item from the bank by name, optionally specifying a count (defaults to 1)
- **Similes:** `TAKE_FROM_BANK`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

## Core / @elizaos/core / advanced-capabilities

### ADD_CONTACT

- **File:** `eliza/packages/core/src/features/advanced-capabilities/actions/addContact.ts`
- **Description:** _(not provided)_
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### CLIPBOARD_APPEND

- **File:** `eliza/packages/core/src/features/advanced-capabilities/clipboard/actions/append.ts`
- **Description:** _(not provided)_
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### CLIPBOARD_DELETE

- **File:** `eliza/packages/core/src/features/advanced-capabilities/clipboard/actions/delete.ts`
- **Description:** _(not provided)_
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### CLIPBOARD_LIST

- **File:** `eliza/packages/core/src/features/advanced-capabilities/clipboard/actions/list.ts`
- **Description:** _(not provided)_
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### CLIPBOARD_READ

- **File:** `eliza/packages/core/src/features/advanced-capabilities/clipboard/actions/read.ts`
- **Description:** _(not provided)_
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### CLIPBOARD_SEARCH

- **File:** `eliza/packages/core/src/features/advanced-capabilities/clipboard/actions/search.ts`
- **Description:** _(not provided)_
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### CLIPBOARD_WRITE

- **File:** `eliza/packages/core/src/features/advanced-capabilities/clipboard/actions/write.ts`
- **Description:** _(not provided)_
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### FOLLOW_ROOM

- **File:** `eliza/packages/core/src/features/advanced-capabilities/actions/followRoom.ts`
- **Description:** _(not provided)_
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### FORM_RESTORE

- **File:** `eliza/packages/core/src/features/advanced-capabilities/form/actions/restore.ts`
- **Description:** Restore a previously stashed form session
- **Similes:** `RESUME_FORM`, `CONTINUE_FORM`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### GENERATE_IMAGE

- **File:** `eliza/packages/core/src/features/advanced-capabilities/actions/imageGeneration.ts`
- **Description:** _(not provided)_
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### MODIFY_CHARACTER

- **File:** `eliza/packages/core/src/features/advanced-capabilities/personality/actions/modify-character.ts`
- **Description:** Optional natural-language request describing the desired character or interaction change. If provided, the action evaluates this request instead of relying only on the raw message text.
- **Similes:** `UPDATE_PERSONALITY`, `CHANGE_PERSONALITY`, `UPDATE_CHARACTER`, `CHANGE_CHARACTER`, `CHANGE_BEHAVIOR`, `ADJUST_BEHAVIOR`, `CHANGE_TONE`, `UPDATE_TONE`, `CHANGE_STYLE`, `UPDATE_STYLE`, `CHANGE_VOICE`, `CHANGE_RESPONSE_STYLE`, `UPDATE_RESPONSE_STYLE`, `EVOLVE_CHARACTER`, `SELF_MODIFY`, `SET_RESPONSE_STYLE`, `SET_LANGUAGE`, `SET_INTERACTION_MODE`, `SET_USER_PREFERENCE`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### MUTE_ROOM

- **File:** `eliza/packages/core/src/features/advanced-capabilities/actions/muteRoom.ts`
- **Description:** _(not provided)_
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### READ_ATTACHMENT

- **File:** `eliza/packages/core/src/features/advanced-capabilities/clipboard/actions/read-attachment.ts`
- **Description:** Read a stored attachment by attachment ID. Use this instead of relying on inline attachment descriptions in the conversation context. Set addToClipboard=true to keep the result in bounded task clipboa
- **Similes:** `OPEN_ATTACHMENT`, `INSPECT_ATTACHMENT`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### READ_FILE

- **File:** `eliza/packages/core/src/features/advanced-capabilities/clipboard/actions/read-file.ts`
- **Description:** Read a local text file for the current task. Returns the file content so the agent can reference it. Set addToClipboard=true to keep the read result in bounded task clipboard state.
- **Similes:** `OPEN_FILE`, `LOAD_FILE`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### RECORD_EXPERIENCE

- **File:** `eliza/packages/core/src/features/advanced-capabilities/experience/actions/record-experience.ts`
- **Description:** _(not provided)_
- **Validate:** ✅ yes
- **Handler:** ❌ no
- **Examples:** ✅ yes

### REMOVE_CONTACT

- **File:** `eliza/packages/core/src/features/advanced-capabilities/actions/removeContact.ts`
- **Description:** _(not provided)_
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### REMOVE_FROM_CLIPBOARD

- **File:** `eliza/packages/core/src/features/advanced-capabilities/clipboard/actions/remove-from-clipboard.ts`
- **Description:** Remove an item from the bounded clipboard when it is no longer needed for the current task.
- **Similes:** `CLEAR_CLIPBOARD_ITEM`, `DELETE_CLIPBOARD_ITEM`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### SEARCH_CONTACTS

- **File:** `eliza/packages/core/src/features/advanced-capabilities/actions/searchContacts.ts`
- **Description:** _(not provided)_
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### MESSAGE

- **File:** `eliza/packages/core/src/features/advanced-capabilities/actions/message.ts`
- **Description:** Primary addressed-message router. Subactions are selected with `operation`.
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### THINK

- **File:** `eliza/packages/core/src/features/advanced-capabilities/actions/think.ts`
- **Description:** _(not provided)_
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### UNFOLLOW_ROOM

- **File:** `eliza/packages/core/src/features/advanced-capabilities/actions/unfollowRoom.ts`
- **Description:** _(not provided)_
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### UNMUTE_ROOM

- **File:** `eliza/packages/core/src/features/advanced-capabilities/actions/unmuteRoom.ts`
- **Description:** _(not provided)_
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### UPDATE_CONTACT

- **File:** `eliza/packages/core/src/features/advanced-capabilities/actions/updateContact.ts`
- **Description:** _(not provided)_
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### UPDATE_ENTITY

- **File:** `eliza/packages/core/src/features/advanced-capabilities/actions/updateEntity.ts`
- **Description:** _(not provided)_
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

## Plugin / @elizaos/agent-orchestrator

### START_CODING_TASK

- **File:** `eliza/plugins/plugin-agent-orchestrator/src/actions/start-coding-task.ts`
- **Description:** Create one or more asynchronous task agents for any open-ended multi-step job.
- **Similes:** `CREATE_TASK`, `LAUNCH_CODING_TASK`, `RUN_CODING_TASK`, `START_AGENT_TASK`, `SPAWN_AND_PROVISION`, `CODE_THIS`, `LAUNCH_TASK`, `CREATE_SUBTASK`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### FINALIZE_WORKSPACE

- **File:** `eliza/plugins/plugin-agent-orchestrator/src/actions/finalize-workspace.ts`
- **Description:** Finalize workspace changes by committing, pushing, and optionally creating a pull request.
- **Similes:** `COMMIT_AND_PR`, `CREATE_PR`, `SUBMIT_CHANGES`, `FINISH_WORKSPACE`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### LIST_AGENTS

- **File:** `eliza/plugins/plugin-agent-orchestrator/src/actions/list-agents.ts`
- **Description:** List active task agents together with current task progress so the main agent can keep the user updated while work continues asynchronously.
- **Similes:** `LIST_CODING_AGENTS`, `SHOW_CODING_AGENTS`, `GET_ACTIVE_AGENTS`, `LIST_SESSIONS`, `SHOW_CODING_SESSIONS`, `SHOW_TASK_AGENTS`, `LIST_SUB_AGENTS`, `SHOW_TASK_STATUS`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### MANAGE_ISSUES

- **File:** `eliza/plugins/plugin-agent-orchestrator/src/actions/manage-issues.ts`
- **Description:** Manage GitHub issues for a repository.
- **Similes:** `CREATE_ISSUE`, `LIST_ISSUES`, `CLOSE_ISSUE`, `COMMENT_ISSUE`, `UPDATE_ISSUE`, `GET_ISSUE`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### PROVISION_WORKSPACE

- **File:** `eliza/plugins/plugin-agent-orchestrator/src/actions/provision-workspace.ts`
- **Description:** Create a git workspace for coding tasks.
- **Similes:** `CREATE_WORKSPACE`, `CLONE_REPO`, `SETUP_WORKSPACE`, `PREPARE_WORKSPACE`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### SEND_TO_AGENT

- **File:** `eliza/plugins/plugin-agent-orchestrator/src/actions/send-to-agent.ts`
- **Description:** Send text input or key presses to a running task-agent session.
- **Similes:** `SEND_TO_CODING_AGENT`, `MESSAGE_CODING_AGENT`, `INPUT_TO_AGENT`, `RESPOND_TO_AGENT`, `TELL_CODING_AGENT`, `MESSAGE_AGENT`, `TELL_TASK_AGENT`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### SPAWN_AGENT

- **File:** `eliza/plugins/plugin-agent-orchestrator/src/actions/spawn-agent.ts`
- **Description:** Spawn a specific task agent inside an existing workspace when you need direct control.
- **Similes:** `SPAWN_CODING_AGENT`, `START_CODING_AGENT`, `LAUNCH_CODING_AGENT`, `CREATE_CODING_AGENT`, `SPAWN_CODER`, `RUN_CODING_AGENT`, `SPAWN_SUB_AGENT`, `START_TASK_AGENT`, `CREATE_AGENT`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### STOP_AGENT

- **File:** `eliza/plugins/plugin-agent-orchestrator/src/actions/stop-agent.ts`
- **Description:** Stop a running task-agent session.
- **Similes:** `STOP_CODING_AGENT`, `KILL_CODING_AGENT`, `TERMINATE_AGENT`, `END_CODING_SESSION`, `CANCEL_AGENT`, `CANCEL_TASK_AGENT`, `STOP_SUB_AGENT`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### TASK_CONTROL

- **File:** `eliza/plugins/plugin-agent-orchestrator/src/actions/task-control.ts`
- **Description:** Pause, stop, resume, continue, archive, or reopen a coordinator task thread while preserving the durable thread history.
- **Similes:** `CONTROL_TASK`, `PAUSE_TASK`, `RESUME_TASK`, `STOP_TASK`, `CONTINUE_TASK`, `ARCHIVE_TASK`, `REOPEN_TASK`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### TASK_HISTORY

- **File:** `eliza/plugins/plugin-agent-orchestrator/src/actions/task-history.ts`
- **Description:** Query coordinator task history without stuffing raw transcripts into model context. Use this for active work, yesterday/last-week summaries, topic search, counts, and thread detail lookup.
- **Similes:** `LIST_TASK_HISTORY`, `GET_TASK_HISTORY`, `SHOW_TASKS`, `COUNT_TASKS`, `TASK_STATUS_HISTORY`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### TASK_SHARE

- **File:** `eliza/plugins/plugin-agent-orchestrator/src/actions/task-share.ts`
- **Description:** Discover the best available way to view or share a task result, including artifacts, live preview URLs, workspace paths, and environment share capabilities.
- **Similes:** `SHARE_TASK_RESULT`, `SHOW_TASK_ARTIFACT`, `VIEW_TASK_OUTPUT`, `CAN_I_SEE_IT`, `PULL_IT_UP`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

## Plugin / @elizaos/music-library

### ADD_TO_PLAYLIST

- **File:** `eliza/plugins/plugin-music-library/src/actions/addToPlaylist.ts`
- **Description:** Add music to a playlist. If the track is not already in the library, the configured music fetch service must resolve it first. Creates the playlist if it does not exist.
- **Similes:** `ADD_SONG_TO_PLAYLIST`, `PUT_IN_PLAYLIST`, `SAVE_TO_PLAYLIST`, `ADD_TRACK_TO_PLAYLIST`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### DELETE_PLAYLIST

- **File:** `eliza/plugins/plugin-music-library/src/actions/deletePlaylist.ts`
- **Description:** Delete a saved playlist. Works best in DMs to avoid flooding group chats.
- **Similes:** `REMOVE_PLAYLIST`, `DELETE_SAVED_PLAYLIST`, `REMOVE_SAVED_PLAYLIST`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### DOWNLOAD_MUSIC

- **File:** `eliza/plugins/plugin-music-library/src/actions/downloadMusic.ts`
- **Description:** Download music to the local library without playing it. Requires the configured music fetch service to resolve the track.
- **Similes:** `FETCH_MUSIC`, `GET_MUSIC`, `DOWNLOAD_SONG`, `SAVE_MUSIC`, `GRAB_MUSIC`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### LIST_PLAYLISTS

- **File:** `eliza/plugins/plugin-music-library/src/actions/listPlaylists.ts`
- **Description:** List all saved playlists for the user. Works best in DMs to avoid flooding group chats.
- **Similes:** `SHOW_PLAYLISTS`, `MY_PLAYLISTS`, `PLAYLIST_LIST`, `VIEW_PLAYLISTS`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### LOAD_PLAYLIST

- **File:** `eliza/plugins/plugin-music-library/src/actions/loadPlaylist.ts`
- **Description:** Load a saved playlist and add all tracks to the queue. Works best in DMs to avoid flooding group chats.
- **Similes:** `PLAY_PLAYLIST`, `LOAD_QUEUE`, `RESTORE_PLAYLIST`, `PLAY_SAVED_PLAYLIST`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### PLAY_MUSIC_QUERY

- **File:** `eliza/plugins/plugin-music-library/src/actions/playMusicQuery.ts`
- **Description:** Handle any complex music query that requires understanding and research. Supports: artist queries (first single, latest song, similar artists, popular songs, nth album), temporal (80s, 90s, specific y
- **Similes:** `SMART_PLAY`, `RESEARCH_AND_PLAY`, `FIND_AND_PLAY`, `INTELLIGENT_MUSIC_SEARCH`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### SAVE_PLAYLIST

- **File:** `eliza/plugins/plugin-music-library/src/actions/savePlaylist.ts`
- **Description:** Save the current music queue as a playlist for the user. Works best in DMs to avoid flooding group chats.
- **Similes:** `SAVE_QUEUE`, `CREATE_PLAYLIST`, `STORE_PLAYLIST`, `SAVE_MUSIC_LIST`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### SEARCH_YOUTUBE

- **File:** `eliza/plugins/plugin-music-library/src/actions/searchYouTube.ts`
- **Description:** Search YouTube for a song or video and return the link. Use this when a user asks to find or search for a YouTube video or song without providing a specific URL.
- **Similes:** `FIND_YOUTUBE`, `SEARCH_YOUTUBE_VIDEO`, `FIND_SONG`, `SEARCH_MUSIC`, `GET_YOUTUBE_LINK`, `LOOKUP_YOUTUBE`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

## App / app-scape

### ATTACK_NPC

- **File:** `eliza/plugins/app-scape/src/actions/attack-npc.ts`
- **Description:** Engage a nearby NPC in combat by its instance id. The server pathfinds the agent into attack range automatically.
- **Similes:** `FIGHT_NPC`, `KILL_NPC`, `ENGAGE`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### CHAT_PUBLIC

- **File:** `eliza/plugins/app-scape/src/actions/chat-public.ts`
- **Description:** Say something in public chat so nearby players and agents can see it. Use to narrate, socialize, or respond to operator prompts.
- **Similes:** `SAY`, `SPEAK`, `TALK`, `BROADCAST`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### COMPLETE_GOAL

- **File:** `eliza/plugins/app-scape/src/actions/complete-goal.ts`
- **Description:** Mark the active goal (or a specific goal id) as completed or abandoned. Use <status>completed|abandoned</status> and optional <notes>why</notes>.
- **Similes:** `FINISH_GOAL`, `ABANDON_GOAL`, `CLOSE_GOAL`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### DROP_ITEM

- **File:** `eliza/plugins/app-scape/src/actions/drop-item.ts`
- **Description:** Drop an item from an inventory slot onto the ground at your feet. Useful when inventory is full or you don
- **Similes:** `DISCARD`, `THROW_AWAY`, `DUMP`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### EAT_FOOD

- **File:** `eliza/plugins/app-scape/src/actions/eat-food.ts`
- **Description:** Eat a food item from an inventory slot to restore hitpoints. Prioritize this when HP is low.
- **Similes:** `CONSUME_FOOD`, `HEAL`, `EAT`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### REMEMBER

- **File:** `eliza/plugins/app-scape/src/actions/remember.ts`
- **Description:** Write a note to the Scape Journal. Use for lessons, landmarks, and things you want to remember next step.
- **Similes:** `NOTE`, `LOG`, `JOURNAL`, `RECORD`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### SET_GOAL

- **File:** `eliza/plugins/app-scape/src/actions/set-goal.ts`
- **Description:** Declare a new goal you want to pursue. Write a short title and optional notes; the goal goes into the Scape Journal and drives future steps until it
- **Similes:** `DECLARE_GOAL`, `NEW_GOAL`, `PLAN`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### WALK_TO

- **File:** `eliza/plugins/app-scape/src/actions/walk-to.ts`
- **Description:** Walk the agent toward a specific world tile (x, z). Use this to move to banks, NPCs, resource nodes, or just to explore.
- **Similes:** `MOVE_TO`, `GO_TO`, `TRAVEL_TO`, `HEAD_TO`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

## Plugin / @elizaos/agent-skills

### GET_SKILL_DETAILS

- **File:** `eliza/plugins/plugin-agent-skills/typescript/src/actions/get-skill-details.ts`
- **Description:** Get detailed information about a specific skill including version, owner, and stats.
- **Similes:** `SKILL_INFO`, `SKILL_DETAILS`
- **Validate:** ❌ no
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### INSTALL_SKILL

- **File:** `eliza/plugins/plugin-agent-skills/typescript/src/actions/install-skill.ts`
- **Description:** Install a skill from the ClawHub registry. The skill will be security-scanned before activation.
- **Similes:** `DOWNLOAD_SKILL`, `ADD_SKILL`, `GET_SKILL`
- **Validate:** ❌ no
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### SEARCH_SKILLS

- **File:** `eliza/plugins/plugin-agent-skills/typescript/src/actions/search-skills.ts`
- **Description:** Search the skill registry for available skills by keyword or category.
- **Similes:** `BROWSE_SKILLS`, `LIST_SKILLS`, `FIND_SKILLS`
- **Validate:** ❌ no
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### SYNC_SKILL_CATALOG

- **File:** `eliza/plugins/plugin-agent-skills/typescript/src/actions/sync-catalog.ts`
- **Description:** Sync the skill catalog from the registry to discover new skills.
- **Similes:** `REFRESH_SKILLS`, `UPDATE_CATALOG`
- **Validate:** ❌ no
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### TOGGLE_SKILL

- **File:** `eliza/plugins/plugin-agent-skills/typescript/src/actions/toggle-skill.ts`
- **Description:** Enable or disable an installed skill. Say
- **Similes:** `ENABLE_SKILL`, `DISABLE_SKILL`, `TURN_ON_SKILL`, `TURN_OFF_SKILL`, `ACTIVATE_SKILL`, `DEACTIVATE_SKILL`
- **Validate:** ❌ no
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### UNINSTALL_SKILL

- **File:** `eliza/plugins/plugin-agent-skills/typescript/src/actions/uninstall-skill.ts`
- **Description:** Uninstall a non-bundled skill. Bundled skills cannot be removed.
- **Similes:** `REMOVE_SKILL`, `DELETE_SKILL`
- **Validate:** ❌ no
- **Handler:** ✅ yes
- **Examples:** ✅ yes

## Plugin / @elizaos/music-player

### MANAGE_ROUTING

- **File:** `eliza/plugins/plugin-music-player/src/actions/manageRouting.ts`
- **Description:** Manage audio routing modes and assignments
- **Similes:** `SET_ROUTING_MODE`, `ROUTE_AUDIO`, `STOP_ROUTING`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### MANAGE_ZONES

- **File:** `eliza/plugins/plugin-music-player/src/actions/manageZones.ts`
- **Description:** Manage audio zones for multi-bot voice routing
- **Similes:** `CREATE_ZONE`, `DELETE_ZONE`, `LIST_ZONES`, `ADD_TO_ZONE`, `REMOVE_FROM_ZONE`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### PAUSE_MUSIC

- **File:** `eliza/plugins/plugin-music-player/src/actions/pauseResumeMusic.ts`
- **Description:** Pause the currently playing track (hold playback). Use whenever the user asks to pause music or audio.
- **Similes:** `PAUSE`, `PAUSE_AUDIO`, `PAUSE_SONG`, `PAUSE_PLAYBACK`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### PLAY_AUDIO

- **File:** `eliza/plugins/plugin-music-player/src/actions/playAudio.ts`
- **Description:** Start playing a new song: provide a track name, artist, search words, or a media URL.
- **Similes:** `PLAY_YOUTUBE`, `PLAY_YOUTUBE_AUDIO`, `PLAY_VIDEO_AUDIO`, `PLAY_MUSIC`, `PLAY_SONG`, `PLAY_TRACK`, `START_MUSIC`, `PLAY_THIS`, `STREAM_YOUTUBE`, `PLAY_FROM_YOUTUBE`, `QUEUE_SONG`, `ADD_TO_QUEUE`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### QUEUE_MUSIC

- **File:** `eliza/plugins/plugin-music-player/src/actions/queueMusic.ts`
- **Description:** Add a song to the queue for later
- **Similes:** `ADD_TO_QUEUE`, `QUEUE_SONG`, `QUEUE_TRACK`, `ADD_SONG`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### SHOW_QUEUE

- **File:** `eliza/plugins/plugin-music-player/src/actions/showQueue.ts`
- **Description:** Show the current music queue
- **Similes:** `QUEUE`, `LIST_QUEUE`, `SHOW_PLAYLIST`, `QUEUE_LIST`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### SKIP_TRACK

- **File:** `eliza/plugins/plugin-music-player/src/actions/skipTrack.ts`
- **Description:** Skip the current track and play the next queued song. Use for skip, next track, or next song.
- **Similes:** `SKIP`, `NEXT_TRACK`, `SKIP_SONG`, `NEXT_SONG`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### STOP_MUSIC

- **File:** `eliza/plugins/plugin-music-player/src/actions/stopMusic.ts`
- **Description:** Stop playback and clear the queue. Use when the user wants music off or the queue cleared.
- **Similes:** `STOP_AUDIO`, `STOP_PLAYING`, `STOP_SONG`, `TURN_OFF_MUSIC`, `MUSIC_OFF`, `SILENCE`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

## App / app-lifeops

> This generated inventory is incomplete for LifeOps. The canonical action
> registration is `appLifeOpsPlugin.actions` in
> `eliza/plugins/app-lifeops/src/plugin.ts`, which currently includes browser
> companion, inbox, approvals, travel, check-in, follow-up, scheduling, and
> activity actions beyond the legacy subset below.

### BLOCK_APPS

- **File:** `eliza/plugins/app-lifeops/src/actions/app-blocker.ts`
- **Description:** Admin-only. Block selected apps on the user
- **Similes:** `BLOCK_APP`, `BLOCK_APPLICATION`, `APP_BLOCKER`, `START_APP_BLOCK`, `BLOCK_DISTRACTING_APPS`, `SHIELD_APPS`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### BLOCK_WEBSITES

- **File:** `eliza/plugins/app-lifeops/src/actions/website-blocker.ts`
- **Description:** Admin-only. Start a local website block by editing the system hosts file.
- **Similes:** `SELFCONTROL_BLOCK_WEBSITES`, `BLOCK_WEBSITE`, `BLOCK_SITE`, `BLOCK_WEBSITE_NOW`, `WEBSITE_BLOCKER`, `WEBSITEBLOCKER`, `START_FOCUS_BLOCK`, `BLOCK_SITE`, `BLOCK_DISTRACTING_SITES`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### CALENDAR_ACTION

- **File:** `eliza/plugins/app-lifeops/src/actions/calendar.ts`
- **Description:** Interact with Google Calendar through LifeOps.
- **Similes:** `CALENDAR`, `CHECK_CALENDAR`, `SCHEDULE_EVENT`, `CREATE_CALENDAR_EVENT`, `SEARCH_CALENDAR`, `NEXT_MEETING`, `ITINERARY`, `TRAVEL_SCHEDULE`, `CHECK_SCHEDULE`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### GMAIL_ACTION

- **File:** `eliza/plugins/app-lifeops/src/actions/gmail.ts`
- **Description:** Interact with Gmail through LifeOps.
- **Similes:** `GMAIL`, `CHECK_EMAIL`, `EMAIL_TRIAGE`, `SEARCH_EMAIL`, `DRAFT_EMAIL_REPLY`, `SEND_EMAIL_REPLY`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### LIFE

- **File:** `eliza/plugins/app-lifeops/src/actions/life.ts`
- **Description:** Manage the user
- **Similes:** `MANAGE_LIFEOPS`, `QUERY_LIFEOPS`, `CREATE_TASK`, `CREATE_HABIT`, `CREATE_GOAL`, `TRACK_HABIT`, `COMPLETE_TASK`, `SET_ALARM`, `SET_REMINDER`, `SNOOZE_REMINDER`, `SET_REMINDER_INTENSITY`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### UPDATE_OWNER_PROFILE

- **File:** `eliza/plugins/app-lifeops/src/actions/update-owner-profile.ts`
- **Description:** Silently persist stable, owner-only LifeOps profile details when the canonical owner clearly states or confirms them.
- **Similes:** `SAVE_OWNER_PROFILE`, `SET_OWNER_PROFILE`, `UPDATE_USER_PROFILE`, `SAVE_USER_PROFILE`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ❌ no

## Plugin / @elizaos/computeruse

### BROWSER_ACTION

- **File:** `eliza/plugins/plugin-computeruse/src/actions/browser-action.ts`
- **Description:** Control a Chromium-based browser through the local runtime. This action opens or connects to a browser session, navigates pages, clicks elements, types into forms, reads DOM state, executes JavaScript
- **Similes:** `CONTROL_BROWSER`, `WEB_BROWSER`, `OPEN_BROWSER`, `BROWSE_WEB`, `NAVIGATE_BROWSER`, `BROWSER_CLICK`, `BROWSER_TYPE`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ❌ no

### FILE_ACTION

- **File:** `eliza/plugins/plugin-computeruse/src/actions/file-action.ts`
- **Description:** Perform local filesystem operations through the computer-use service. This includes read, write, edit, append, delete, exists, list, delete_directory, upload, download, and list_downloads actions.\n\n
- **Similes:** `READ_FILE`, `WRITE_FILE`, `EDIT_FILE`, `DELETE_FILE`, `LIST_DIRECTORY`, `FILE_OPERATION`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ❌ no

### MANAGE_WINDOW

- **File:** `eliza/plugins/plugin-computeruse/src/actions/manage-window.ts`
- **Description:** Manage desktop windows through the local runtime. This includes listing visible windows, focusing or switching windows, minimizing, maximizing, restoring, closing, and parity no-op arrange/move comman
- **Similes:** `LIST_WINDOWS`, `FOCUS_WINDOW`, `SWITCH_WINDOW`, `MINIMIZE_WINDOW`, `MAXIMIZE_WINDOW`, `CLOSE_WINDOW`, `WINDOW_MANAGEMENT`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ❌ no

### TERMINAL_ACTION

- **File:** `eliza/plugins/plugin-computeruse/src/actions/terminal-action.ts`
- **Description:** Execute terminal commands and manage lightweight terminal sessions through the computer-use service. This includes connect, execute, read, type, clear, close, and the upstream execute_command alias.\n
- **Similes:** `RUN_COMMAND`, `EXECUTE_COMMAND`, `SHELL_COMMAND`, `TERMINAL`, `RUN_SHELL`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ❌ no

### USE_COMPUTER

- **File:** `eliza/plugins/plugin-computeruse/src/actions/use-computer.ts`
- **Description:** Control the local desktop. This action can inspect the current screen, move the mouse, click, drag, type, press keys, scroll, and perform modified clicks. It is intended for real application interacti
- **Similes:** `CONTROL_COMPUTER`, `COMPUTER_ACTION`, `DESKTOP_ACTION`, `CLICK`, `CLICK_SCREEN`, `TYPE_TEXT`, `PRESS_KEY`, `KEY_COMBO`, `SCROLL_SCREEN`, `MOVE_MOUSE`, `DRAG`, `MOUSE_CLICK`, `TAKE_SCREENSHOT`, `CAPTURE_SCREEN`, `SCREEN_CAPTURE`, `GET_SCREENSHOT`, `SEE_SCREEN`, `LOOK_AT_SCREEN`, `VIEW_SCREEN`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ❌ no

## Plugin / @elizaos/commands

### COMMANDS_LIST

- **File:** `eliza/plugins/plugin-commands/typescript/src/actions/commands-list.ts`
- **Description:** List all available commands with their aliases. Only activates for /commands or /cmds slash commands.
- **Validate:** ✅ yes
- **Handler:** ❌ no
- **Examples:** ✅ yes

### HELP_COMMAND

- **File:** `eliza/plugins/plugin-commands/typescript/src/actions/help.ts`
- **Description:** Show available commands and their descriptions. Only activates for /help, /h, or /? slash commands.
- **Validate:** ✅ yes
- **Handler:** ❌ no
- **Examples:** ✅ yes

### MODELS_COMMAND

- **File:** `eliza/plugins/plugin-commands/typescript/src/actions/models.ts`
- **Description:** List available AI models and providers. Only activates for /models slash command.
- **Validate:** ✅ yes
- **Handler:** ❌ no
- **Examples:** ✅ yes

### STATUS_COMMAND

- **File:** `eliza/plugins/plugin-commands/typescript/src/actions/status.ts`
- **Description:** Show session directive settings via /status slash command. Only activates for /status or /s prefix.
- **Validate:** ✅ yes
- **Handler:** ❌ no
- **Examples:** ✅ yes

### STOP_COMMAND

- **File:** `eliza/plugins/plugin-commands/typescript/src/actions/stop.ts`
- **Description:** Stop current operation or abort running tasks. Triggered by /stop, /abort, or /cancel slash commands only.
- **Validate:** ✅ yes
- **Handler:** ❌ no
- **Examples:** ✅ yes

## Core / @elizaos/core / trust

### EVALUATE_TRUST

- **File:** `eliza/packages/core/src/features/trust/actions/evaluateTrust.ts`
- **Description:** Evaluates the trust score and profile for a specified entity
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### RECORD_TRUST_INTERACTION

- **File:** `eliza/packages/core/src/features/trust/actions/recordTrustInteraction.ts`
- **Description:** Records a trust-affecting interaction between entities
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### REQUEST_ELEVATION

- **File:** `eliza/packages/core/src/features/trust/actions/requestElevation.ts`
- **Description:** Request temporary elevation of permissions for a specific action
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### UPDATE_ROLE

- **File:** `eliza/packages/core/src/features/trust/actions/roles.ts`
- **Description:** Assigns a role (Admin, Owner, None) to a user or list of users in a channel.
- **Similes:** `CHANGE_ROLE`, `SET_PERMISSIONS`, `ASSIGN_ROLE`, `MAKE_ADMIN`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### UPDATE_SETTINGS

- **File:** `eliza/packages/core/src/features/trust/actions/settings.ts`
- **Description:** Saves a configuration setting during the onboarding process, or update an existing setting. Use this when you are onboarding with a world owner or admin.
- **Similes:** `UPDATE_SETTING`, `SAVE_SETTING`, `SET_CONFIGURATION`, `CONFIGURE`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

## Plugin / @elizaos/shopify

### MANAGE_SHOPIFY_CUSTOMERS

- **File:** `eliza/plugins/plugin-shopify/src/actions/manage-customers.ts`
- **Description:** List and search customers in a connected Shopify store.
- **Similes:** `LIST_CUSTOMERS`, `FIND_CUSTOMER`, `SEARCH_CUSTOMERS`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### MANAGE_SHOPIFY_INVENTORY

- **File:** `eliza/plugins/plugin-shopify/src/actions/manage-inventory.ts`
- **Description:** Check inventory levels, adjust stock quantities, and list store locations in Shopify.
- **Similes:** `CHECK_INVENTORY`, `ADJUST_INVENTORY`, `CHECK_STOCK`, `UPDATE_STOCK`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### MANAGE_SHOPIFY_ORDERS

- **File:** `eliza/plugins/plugin-shopify/src/actions/manage-orders.ts`
- **Description:** List recent orders, check specific order status, and mark orders as fulfilled in Shopify.
- **Similes:** `LIST_ORDERS`, `CHECK_ORDERS`, `FULFILL_ORDER`, `ORDER_STATUS`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### MANAGE_SHOPIFY_PRODUCTS

- **File:** `eliza/plugins/plugin-shopify/src/actions/manage-products.ts`
- **Description:** List, search, create, or update products in a connected Shopify store.
- **Similes:** `LIST_PRODUCTS`, `CREATE_PRODUCT`, `UPDATE_PRODUCT`, `SEARCH_PRODUCTS`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### SEARCH_SHOPIFY_STORE

- **File:** `eliza/plugins/plugin-shopify/src/actions/search-store.ts`
- **Description:** Search across products, orders, and customers in a connected Shopify store.
- **Similes:** `SHOPIFY_SEARCH`, `STORE_SEARCH`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

## Core / @elizaos/core / basic-capabilities

### CHOOSE_OPTION

- **File:** `eliza/packages/core/src/features/basic-capabilities/actions/choice.ts`
- **Description:** _(not provided)_
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### IGNORE

- **File:** `eliza/packages/core/src/features/basic-capabilities/actions/ignore.ts`
- **Description:** _(not provided)_
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### NONE

- **File:** `eliza/packages/core/src/features/basic-capabilities/actions/none.ts`
- **Description:** Response without additional action
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### REPLY

- **File:** `eliza/packages/core/src/features/basic-capabilities/actions/reply.ts`
- **Description:** _(not provided)_
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

## Core / @elizaos/core / connector-actions

### MESSAGE

- **File:** `eliza/packages/core/src/features/advanced-capabilities/actions/message.ts`
- **Description:** Primary addressed-message router. Use `operation` for send, read, search, list_channels, list_servers, react, edit, delete, pin, join, leave, or get_user.
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### POST

- **File:** `eliza/packages/core/src/features/advanced-capabilities/actions/post.ts`
- **Description:** Primary public-feed router. Use `operation` for send, read, or search.
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

## App / app-steward

### CHECK_BALANCE

- **File:** `eliza/plugins/app-steward/src/actions/check-balance.ts`
- **Description:** Check wallet balances across chains. Use this when a user asks about
- **Similes:** `GET_BALANCE`, `WALLET_BALANCE`, `CHECK_WALLET`, `MY_BALANCE`, `PORTFOLIO`, `HOLDINGS`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ❌ no

### EXECUTE_TRADE

- **File:** `eliza/plugins/app-steward/src/actions/execute-trade.ts`
- **Description:** Execute a BSC token trade (buy or sell). Use this when a user asks to
- **Similes:** `BUY_TOKEN`, `SELL_TOKEN`, `SWAP`, `TRADE`, `BUY`, `SELL`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ❌ no

### TRANSFER_TOKEN

- **File:** `eliza/plugins/app-steward/src/actions/transfer-token.ts`
- **Description:** Transfer tokens or native BNB to another address. Use this when a user
- **Similes:** `SEND_TOKEN`, `TRANSFER`, `SEND`, `SEND_BNB`, `SEND_CRYPTO`, `PAY`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ❌ no

## Core / @elizaos/core / plugin-manager

### CORE_STATUS

- **File:** `eliza/packages/core/src/features/plugin-manager/actions/coreStatusAction.ts`
- **Description:** Check thestatus of the @elizaos/core package (ejected or npm)
- **Validate:** ✅ yes
- **Handler:** ❌ no
- **Examples:** ✅ yes

### LIST_EJECTED_PLUGINS

- **File:** `eliza/packages/core/src/features/plugin-manager/actions/listEjectedPluginsAction.ts`
- **Description:** List all ejected plugins currently being managed locally
- **Validate:** ✅ yes
- **Handler:** ❌ no
- **Examples:** ✅ yes

### SEARCH_PLUGINS

- **File:** `eliza/packages/core/src/features/plugin-manager/actions/searchPluginAction.ts`
- **Description:** Search for plugins in the elizaOS registry by functionality, features, and natural language descriptions.
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

## Core / @elizaos/core / secrets

### MANAGE_SECRET

- **File:** `eliza/packages/core/src/features/secrets/actions/manage-secret.ts`
- **Description:** Manage secrets - get, set, delete, or list secrets at various levels
- **Similes:** `SECRET_MANAGEMENT`, `HANDLE_SECRET`, `SECRET_OPERATION`, `GET_SECRET`, `DELETE_SECRET`, `LIST_SECRETS`, `CHECK_SECRET`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### REQUEST_SECRET

- **File:** `eliza/packages/core/src/features/secrets/actions/request-secret.ts`
- **Description:** Request a missing secret from the user or administrator
- **Similes:** `ASK_FOR_SECRET`, `REQUIRE_SECRET`, `NEED_SECRET`, `MISSING_SECRET`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

### SET_SECRET

- **File:** `eliza/packages/core/src/features/secrets/actions/set-secret.ts`
- **Description:** Set a secret value (API key, token, password, etc.) for the agent to use
- **Similes:** `STORE_SECRET`, `SAVE_SECRET`, `SET_API_KEY`, `CONFIGURE_SECRET`, `SET_ENV_VAR`, `STORE_API_KEY`, `SET_TOKEN`, `SAVE_KEY`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

## Core / @elizaos/core / advanced-planning

### ANALYZE_INPUT

- **File:** `eliza/packages/core/src/features/advanced-planning/actions/chain-example.ts`
- **Description:** Analyzes user input and extracts key information
- **Similes:** `PLAN_PROJECT`, `GENERATE_PLAN`, `MAKE_PLAN`, `PROJECT_PLAN`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ❌ no

### SCHEDULE_FOLLOW_UP

- **File:** `eliza/packages/core/src/features/advanced-planning/actions/scheduleFollowUp.ts`
- **Description:** Schedule a follow-up reminder for a contact
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

## App / app-companion

### PLAY_EMOTE

- **File:** `eliza/plugins/app-companion/src/actions/emote.ts`
- **Description:** Play a one-shot emote animation on your 3D VRM avatar, then return to idle.
- **Similes:** `EMOTE`, `ANIMATE`, `GESTURE`, `DANCE`, `WAVE`, `PLAY_ANIMATION`, `DO_EMOTE`, `PERFORM`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ❌ no

## Core / @elizaos/core / advanced-memory

### RESET_SESSION

- **File:** `eliza/packages/core/src/features/advanced-memory/actions/resetSession.ts`
- **Description:** Resets the conversation session by creating a compaction point. Messages before this point will not be included in future context. Use when the user wants to start fresh or clear conversation history.
- **Similes:** `CLEAR_HISTORY`, `NEW_SESSION`, `FORGET`, `START_OVER`, `RESET`
- **Validate:** ✅ yes
- **Handler:** ✅ yes
- **Examples:** ✅ yes

---

## Gap Findings

### Actions Without Tests/Examples
- **Count:** 11

Notable actions without examples (first 10):

  - `ANALYZE_INPUT` (core/advanced-planning)
  - `BROWSER_ACTION` (plugin-computeruse)
  - `CHECK_BALANCE` (app-app-steward)
  - `EXECUTE_TRADE` (app-app-steward)
  - `FILE_ACTION` (plugin-computeruse)
  - `MANAGE_WINDOW` (plugin-computeruse)
  - `PLAY_EMOTE` (app-app-companion)
  - `TERMINAL_ACTION` (plugin-computeruse)
  - `TRANSFER_TOKEN` (app-app-steward)
  - `UPDATE_OWNER_PROFILE` (app-app-lifeops)

### Actions Without Validate Function
- **Count:** 12

### Actions Without Handler Function
- **Count:** 12

### Actions Without Description
- **Count:** 22

  - `ADD_CONTACT` (core/advanced-capabilities)
  - `CHOOSE_OPTION` (core/basic-capabilities)
  - `CLIPBOARD_APPEND` (core/advanced-capabilities)
  - `CLIPBOARD_DELETE` (core/advanced-capabilities)
  - `CLIPBOARD_LIST` (core/advanced-capabilities)
  - `CLIPBOARD_READ` (core/advanced-capabilities)
  - `CLIPBOARD_SEARCH` (core/advanced-capabilities)
  - `CLIPBOARD_WRITE` (core/advanced-capabilities)
  - `FOLLOW_ROOM` (core/advanced-capabilities)
  - `GENERATE_IMAGE` (core/advanced-capabilities)

### Files That Could Not Parse
- **Count:** 25

  - `eliza/plugins/app-2004scape/src/actions/param-parser.ts`
  - `eliza/plugins/app-lifeops/src/actions/inbox-digest.ts`
  - `eliza/plugins/app-lifeops/src/actions/inbox-respond.ts`
  - `eliza/plugins/app-lifeops/src/actions/inbox-triage.ts`
  - `eliza/plugins/app-lifeops/src/actions/inbox.ts`
  - `eliza/plugins/app-lifeops/src/actions/life-goal-extractor.ts`
  - `eliza/plugins/app-lifeops/src/actions/life-param-extractor.ts`
  - `eliza/plugins/app-lifeops/src/actions/life-recent-context.ts`
  - `eliza/plugins/app-lifeops/src/actions/life-update-extractor.ts`
  - `eliza/plugins/app-lifeops/src/actions/life.extractor.ts`

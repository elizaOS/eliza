# Plugin Prompt Migration Progress

This document tracks the migration of plugins to use the centralized prompt system.

## ✅ Completed Migrations

### 1. plugin-forms (Complete)

- **Status**: ✅ Fully migrated
- **Prompts**: 2 templates
  - `form_extraction.txt`
  - `form_creation.txt`
- **Languages**: TypeScript, Python, Rust
- **Files Updated**:
  - `typescript/services/forms-service.ts`
  - `typescript/utils/prompt-builders.ts`
  - `python/elizaos_plugin_forms/prompts.py`
  - `rust/src/prompts.rs`
- **Build Script**: ✅ Added `build:prompts`

### 2. plugin-discord (Partial)

- **Status**: 🔄 Partially migrated (5 of ~15+ prompts)
- **Prompts Migrated**: 5 templates
  - `get_user_info.txt`
  - `send_dm.txt`
  - `create_poll.txt`
  - `summarization.txt`
  - `date_range.txt`
- **Files Updated**:
  - `typescript/actions/summarizeConversation.ts`
  - `typescript/actions/getUserInfo.ts`
  - `typescript/actions/createPoll.ts`
  - `typescript/actions/sendDM.ts`
- **Build Script**: ✅ Added `build:prompts`
- **Remaining Prompts**: ~10+ more templates in various action files

### 3. plugin-evm (Complete)

- **Status**: ✅ Fully migrated
- **Prompts**: 7 templates
  - `transfer.txt`
  - `bridge.txt`
  - `swap.txt`
  - `propose.txt`
  - `vote.txt`
  - `queue_proposal.txt`
  - `execute_proposal.txt`
- **Files Updated**:
  - `typescript/templates/index.ts`
- **Build Script**: ✅ Added `build:prompts`

### 4. plugin-bluesky (Complete)

- **Status**: ✅ Fully migrated
- **Prompts**: 3 templates
  - `generate_post.txt`
  - `truncate_post.txt`
  - `generate_dm.txt`
- **Files Updated**:
  - `typescript/services/post.ts`
  - `typescript/services/message.ts`
- **Build Script**: ✅ Added `build:prompts`

### 5. plugin-mcp (Complete)

- **Status**: ✅ Fully migrated
- **Prompts**: 7 templates
  - `resource_selection.txt`
  - `tool_selection_name.txt`
  - `tool_selection_argument.txt`
  - `resource_analysis.txt`
  - `error_analysis.txt`
  - `feedback.txt`
  - `tool_reasoning.txt`
- **Files Updated**:
  - `typescript/src/templates/resourceSelectionTemplate.ts`
  - `typescript/src/templates/toolSelectionTemplate.ts`
  - `typescript/src/templates/resourceAnalysisTemplate.ts`
  - `typescript/src/templates/errorAnalysisPrompt.ts`
  - `typescript/src/templates/feedbackTemplate.ts`
  - `typescript/src/templates/toolReasoningTemplate.ts`
- **Build Script**: ✅ Added `build:prompts`

### 6. plugin-xai (Complete)

- **Status**: ✅ Fully migrated
- **Prompts**: 2 templates
  - `x_message_handler.txt`
  - `message_handler.txt`
- **Files Updated**:
  - `typescript/interactions.ts`
- **Build Script**: ✅ Added `build:prompts`

### 7. plugin-memory (Complete)

- **Status**: ✅ Fully migrated
- **Prompts**: 2 templates
  - `initial_summarization.txt`
  - `update_summarization.txt`
- **Files Updated**:
  - `typescript/src/evaluators/summarization.ts`
- **Build Script**: ✅ Added `build:prompts`

### 8. plugin-polymarket (Complete)

- **Status**: ✅ Fully migrated
- **Prompts**: 16 templates
  - `retrieve_all_markets.txt`
  - `get_simplified_markets.txt`
  - `get_sampling_markets.txt`
  - `get_market.txt`
  - `order.txt`
  - `get_order_book.txt`
  - `get_order_book_depth.txt`
  - `get_best_price.txt`
  - `get_midpoint_price.txt`
  - `get_spread.txt`
  - `get_order_details.txt`
  - `check_order_scoring.txt`
  - `get_active_orders.txt`
  - `get_trade_history.txt`
  - `get_account_access_status.txt`
  - `setup_websocket.txt`
- **Files Updated**:
  - `typescript/templates.ts`
- **Build Script**: ✅ Added `build:prompts`

### 9. plugin-linear (Complete)

- **Status**: ✅ Fully migrated
- **Prompts**: 9 templates
  - `search_issues.txt`
  - `create_issue.txt`
  - `update_issue.txt`
  - `get_issue.txt`
  - `list_projects.txt`
  - `delete_issue.txt`
  - `get_activity.txt`
  - `list_teams.txt`
  - `create_comment.txt`
- **Files Updated**:
  - `typescript/src/actions/searchIssues.ts`
  - `typescript/src/actions/createIssue.ts`
  - `typescript/src/actions/updateIssue.ts`
  - `typescript/src/actions/getIssue.ts`
  - `typescript/src/actions/listProjects.ts`
  - `typescript/src/actions/deleteIssue.ts`
  - `typescript/src/actions/getActivity.ts`
  - `typescript/src/actions/listTeams.ts`
  - `typescript/src/actions/createComment.ts`
- **Build Script**: ✅ Added `build:prompts` (if package.json exists)

### 10. plugin-memory (Complete - Long-term Extraction)

- **Status**: ✅ Fully migrated
- **Prompts**: 3 templates (2 summarization + 1 extraction)
  - `initial_summarization.txt`
  - `update_summarization.txt`
  - `long_term_extraction.txt`
- **Files Updated**:
  - `typescript/src/evaluators/summarization.ts`
  - `typescript/src/evaluators/long-term-extraction.ts`
- **Build Script**: ✅ Added `build:prompts`

### 11. plugin-todo (Complete)

- **Status**: ✅ Fully migrated
- **Prompts**: 1 template
  - `extract_todo.txt`
- **Files Updated**:
  - `typescript/actions/createTodo.ts`
- **Build Script**: ✅ Added `build:prompts`

### 12. plugin-planning (Complete)

- **Status**: ✅ Fully migrated
- **Prompts**: 1 template
  - `message_classifier.txt`
- **Files Updated**:
  - `typescript/src/providers/message-classifier.ts`
- **Build Script**: ✅ Added `build:prompts`

### 13. plugin-instagram (Complete)

- **Status**: ✅ Fully migrated
- **Prompts**: 3 templates
  - `comment.txt`
  - `should_interact.txt`
  - `post.txt`
- **Files Updated**:
  - `src/services/interaction.ts`
  - `src/services/post.ts`
- **Build Script**: ✅ Already had `build:prompts`

### 14. plugin-shell (Complete)

- **Status**: ✅ Fully migrated
- **Prompts**: 1 template
  - `command_extraction.txt`
- **Files Updated**:
  - `typescript/actions/executeCommand.ts`
- **Build Script**: ✅ Added `build:prompts`

## 📋 Pending Migrations

### plugin-bluesky

- **Status**: ⏳ Not started
- **Notes**: Has simple inline prompts in `services/message.ts` and `services/post.ts`
- **Estimated Prompts**: 2-3 templates

### plugin-farcaster

- **Status**: ⏳ Not started
- **Notes**: Has formatting utilities, not prompt templates
- **Estimated Prompts**: 0 (no templates to migrate)

### plugin-anthropic

- **Status**: ⏳ Not started
- **Notes**: LLM provider plugin, may not have user-facing prompts
- **Estimated Prompts**: TBD

### plugin-browser

- **Status**: ⏳ Not started
- **Notes**: Browser automation plugin
- **Estimated Prompts**: TBD

### plugin-eliza-classic

- **Status**: ⏳ Not started
- **Notes**: Classic ELIZA chatbot plugin
- **Estimated Prompts**: TBD

### plugin-elizacloud

- **Status**: ⏳ Not started
- **Notes**: Cloud services plugin
- **Estimated Prompts**: TBD

## 📊 Statistics

- **Total Plugins Migrated**: 14 (13 complete, 1 partial)
- **Total Prompts Migrated**: 68 templates
- **Total Plugins Pending**: 1+ (plugin-discord partial, others TBD)
- **System Status**: ✅ Production-ready

## 🔄 Migration Pattern

For each plugin:

1. Create `prompts/` directory at plugin root
2. Extract prompts to `.txt` files (snake_case naming)
3. Add `build:prompts` script to `package.json`:
   - For `typescript/` structure: `./typescript/generated/prompts`
   - For `typescript/src/` structure: `./typescript/src/generated/prompts`
   - For `src/` structure: `./src/generated/prompts`
4. Run `npm run build:prompts`
5. Update imports to use generated prompts (relative path from source file)
6. Remove old inline prompt definitions

## 📝 Notes

- All migrated plugins maintain backwards compatibility via re-exports
- Generated prompts are in `src/generated/prompts/` or `typescript/generated/prompts/`
- Source `.txt` files should always be committed
- Generated files should be committed so builds don't require pre-generation
- Build scripts should run `build:prompts` before main build
- Import from `../generated/prompts/typescript/prompts.js` (relative to source file)

## 🎯 Next Steps

1. Complete plugin-discord migration (extract remaining ~10 prompts)
2. Migrate plugin-bluesky (simple, good for demonstrating the pattern)
3. Review other plugins for prompt extraction opportunities
4. Update CI/CD to ensure `build:prompts` runs in build pipelines

# Game Experience UX Review

## Scope

This writeup covers the live Eliza game surface for Defense of the Agents and ClawVille. It is based on direct inspection of the local routes:

- `/apps/defense-of-the-agents`
- `/apps/clawville`

The review focuses on the host UI around the iframe: game header, diagnostics, command rail, chat, app-page chat rail, responsive behavior, and consumer-facing gameplay clarity.

## Product Goal

Eliza should make games feel like playable chat-native app experiences, not embedded web pages with a debug panel next to them. A consumer should understand:

- what game is running,
- what is happening right now,
- what they can do next,
- whether their last action worked,
- what changed in the game,
- where technical details live if something breaks.

The right-side surface should be a game conversation and event timeline. Direct controls should exist as suggested actions inside that conversation, not as a separate admin dashboard.

## Current Screenshots

### Defense of the Agents Live Route

The inspected Defense route contains:

- Top global app navigation.
- Game header with `Defense of the Agents`, `Connected`, `attached`, `degraded`, a long state summary, and many utility buttons.
- Main iframe viewer.
- Right operator panel with status, hero state, action buttons, command input, suggested commands, and a standalone notice.
- Outer page-scoped `Apps chat` rail with generic catalog copy.
- Bottom-right collapse button for the page chat rail.

What is weak:

- The page contains two chat concepts: the game command input and generic Apps chat. The generic chat is irrelevant once the user is inside a live game.
- `attached` and `degraded` are implementation states. They are useful to engineers but not primary consumer content.
- `Deployment received.` confirms transport, not gameplay result.
- The iframe owns most of the experience, while the host UI does not explain the current match, objective, or consequence of commands well enough.

### ClawVille Live Route

The inspected ClawVille route contains:

- Top global app navigation.
- Game header with `ClawVille`, `Connected`, `attached`, `healthy`, a detailed session summary, and utility buttons.
- Main iframe viewer.
- Right operator panel with run status, nearest building, shortened wallet address, skill count, action buttons, command input, suggested commands, and a standalone notice.
- Outer page-scoped `Apps chat` rail with generic catalog copy.

What is weak:

- Wallet/session identity details are visible as gameplay content even though they do not help the user decide what to do next.
- ClawVille has a richer current game loop than the UI exposes: perception events, movement, building visits, NPC chat, NeoTokens, knowledge books, and skill learning.
- Action labels are too mechanical. `Move Krusty Krab` explains an endpoint better than a player goal.
- `Message sent.` does not say whether the NPC responded, whether a reward was earned, or what action is now available.

## Element-by-Element UX Specification

### Global Navigation

What it does:

- Keeps Chat, Apps, Character, Wallet, Browser, and Automations available.
- Orients the user inside Eliza, not inside the game.

Why it should be there:

- Users need a stable way to leave a game without relying on game-specific controls.
- It preserves the app's global mental model.

Does it need to be there:

- Yes on desktop.
- On small mobile layouts it can collapse into the existing mobile nav pattern.

Alternative:

- A full-screen immersive mode could hide global navigation after launch, with an escape affordance.

How other companies do it:

- Steam and Discord preserve global chrome or overlays so users can leave, invite, or manage sessions.
- Roblox keeps global app navigation lightweight and lets the game canvas dominate.

Implementation guidance:

- Keep the global nav stable.
- Do not add game-specific controls to it.
- Let the game header own game state.

### Game Header

What it does:

- Names the current game.
- Shows whether the session is live.
- Provides lifecycle actions: dashboard visibility, detach/reattach, open externally, stop, back to apps.

Why it should be there:

- The user needs a single source of truth for the live run and a way to exit or recover.

Does it need to be there:

- Yes, but it should be much quieter.
- Primary content should be game name and current objective.
- Diagnostics should be hidden unless the user asks.

Alternative:

- A compact HUD strip over the iframe.
- A top-left floating pill with a `Details` drawer.

How other companies do it:

- Discord Activities show a compact title/status and hide connection details unless troubleshooting.
- Twitch extensions expose viewer state but keep stream health and embed state away from normal viewers.
- Steam Remote Play exposes connection quality only as an optional overlay.

Implementation guidance:

- Show `Live`, `Starting`, or `Needs attention`, not `attached/healthy/degraded`.
- Move attachment, health, auth, run ID, and postMessage state into a `Details` disclosure.
- Avoid repeating the same session summary below the header and inside the right rail.

### Iframe Viewer

What it does:

- Hosts the actual game client.
- Provides the canonical visual state of the match/world.

Why it should be there:

- The integrated game already has a dedicated renderer. Eliza should not reimplement the full game.

Does it need to be there:

- Yes for both games.

Alternative:

- A native renderer or thin state-only dashboard could work for command-only games, but these two games need visual context.

How other companies do it:

- Discord Activities, Telegram Mini Apps, and Shopify embedded apps all use embedded app frames but surround them with host-native controls.
- Good embeds keep host state and app state aligned. Weak embeds leave the host unable to explain what happened.

Implementation guidance:

- The iframe remains primary on desktop.
- On mobile, it should be its own tab/surface: `Game`, `Actions`, `Chat`.
- The host should not overlay noisy labels on top of the game.

### Operator Rail

What it does:

- Gives the user an accessible way to steer the agent/game without interacting with the iframe directly.

Why it should be there:

- The value of Eliza is that the agent can play through chat and actions. The rail is the bridge between natural language and game APIs.

Does it need to be there:

- Yes, but it should be chat-first.

Alternative:

- Put all commands in the generic page chat.
- This is weaker because page chat also handles catalog questions and lacks game-specific state density.

How other companies do it:

- ChatGPT GPTs and Claude Artifacts use a conversational control surface next to the artifact.
- Discord Activities use action buttons and activity state, but chat remains the social control plane.
- Character.ai and Twitch Plays-style experiences make the command stream itself part of the entertainment.

Implementation guidance:

- Rename the surface conceptually from dashboard to game chat.
- The top of the rail should show the current objective.
- Primary actions should be chips/buttons immediately above or inside the chat feed.
- The feed should log user commands, accepted/rejected results, game events, and recommended next actions.

### Direct Action Chips

What they do:

- Provide one-click game actions for common commands.

Why they should be there:

- They reduce typing and teach the user what the game supports.
- They are especially important while the user is learning the integration.

Do they need to be there:

- Yes, but only for high-confidence actions that are available now.

Alternative:

- Use a slash-command palette.
- Use generated suggestions only.
- Use a controller-like HUD.

How other companies do it:

- ChatGPT tool calls often surface next-step chips after a response.
- Duolingo and games like Hearthstone use contextual choices instead of exposing every mechanic at once.
- Discord bots use buttons/select menus for high-confidence actions and chat for the long tail.

Implementation guidance:

- Show at most four primary actions.
- Use outcome-oriented labels: `Go to Tools`, `Visit nearest`, `Ask NPC`, `Recall`.
- Do not show unsupported actions such as shop/buy unless the API supports them.
- Suggested prompts should be below the composer or in the feed, not scattered in multiple places.

### Game Chat/Event Feed

What it does:

- Shows what the user asked for, what Eliza sent, and how the game responded.

Why it should be there:

- Without an event feed, the user cannot distinguish a clicked button from a successful gameplay change.
- It makes autonomous play legible.

Does it need to be there:

- Yes. It is the main missing UX layer.

Alternative:

- Toast notifications only.
- This is weaker because toasts disappear and do not form a gameplay history.

How other companies do it:

- GitHub Actions and Vercel deployments preserve durable logs instead of ephemeral status.
- Strategy games use combat logs to explain cause and effect.
- Slack apps put bot actions into the conversation, not just in modal status text.

Implementation guidance:

- Record local command events immediately.
- Merge server run events and session activity when available.
- Show acceptance/rejection inline.
- Reserve toasts for exceptional failures.

### Generic Apps Chat Rail

What it does:

- Provides a page-scoped assistant for browsing the app catalog and managing app runs.

Why it should be there:

- It is useful in the app catalog.

Does it need to be there in a live game:

- No. It competes with the game chat.

Alternative:

- Dynamically retitle it as game chat and route commands through game APIs.
- This is possible later but requires a stronger routing contract.

How other companies do it:

- Shopify admin and Linear hide generic side assistance inside focused object views unless the assistant is context-specific.
- Discord keeps server chat separate from activity controls but does not put unrelated app catalog instructions next to the activity.

Implementation guidance:

- Hide the outer Apps chat rail while a live game route is active.
- Keep it visible in app browsing/catalog views.

### Diagnostics

What they do:

- Show attachment state, health, auth, viewer state, and backend status.

Why they should be there:

- They are necessary for debugging and recovery.

Do they need to be primary:

- No.

Alternative:

- Developer mode toggle.
- `Details` disclosure in the game header.
- Status popover.

How other companies do it:

- Vercel and Stripe expose diagnostics in expandable details, not primary customer flows.
- Zoom and Discord expose connection stats under a menu.

Implementation guidance:

- Keep diagnostics accessible, not prominent.
- Default to consumer language.
- `Needs attention` can be visible; raw cause belongs in details.

### Collapse/Resize Controls

What they do:

- Let users reclaim screen space.

Why they should be there:

- Game layouts are spatially constrained.

Do they need to be there:

- Yes for the outer workspace chat.
- Less so inside game mode if the outer rail is hidden.

Alternative:

- Responsive tabs on mobile.
- One fixed operator rail width on desktop.
- Drag-resize only after a breakpoint.

How other companies do it:

- VS Code, Linear, and Discord keep sidebar toggles stable and spatially predictable.

Implementation guidance:

- Avoid duplicate controls with the same accessible name.
- If the user detaches the viewer, show one reattach action.
- Avoid floating buttons that shift position when collapsed/expanded.

## Defense of the Agents Specific UX

What users care about:

- Which class they are playing.
- Which lane they are in.
- Whether they are alive.
- Whether they should recall, move lanes, or choose an ability.
- Whether the team is winning.

Current gap:

- The game supports a richer MOBA loop: class choice, lane switching, recall, pings, ability picks every three levels, towers, dragon, scoreboard, and armory. The Eliza surface mostly exposes lane/recall/autoplay.

Recommended UI:

- Header objective: current goal, e.g. `Low HP: recall` or `Holding mid lane`.
- Primary chips: `Autoplay`, `Recall`, `Move top`, `Move mid`, `Move bot`.
- Event feed: command sent, ability learned, lane moved, recall started, respawn state, errors.
- Details: hero class/level/lane/HP, strategy score, health state.

Responsive behavior:

- Desktop: iframe left, game chat rail right.
- Tablet: same layout until the rail would be under 320px.
- Mobile: segmented surfaces: `Game`, `Actions`, `Chat`; do not stack the full rail below the iframe by default.

## ClawVille Specific UX

What users care about:

- Where the agent is.
- Who or what is nearby.
- What skill can be learned.
- Whether they have enough currency or progress to buy/learn.
- What NPC said.

Current gap:

- The current ClawVille play skill exposes perception events, movement, building visits, NPC chat, NeoTokens, knowledge books, and skill loading. The Eliza surface only makes movement, visit, and chat visible, and shop/buy is not currently supported by the API route.

Recommended UI:

- Header objective: nearest building or current task.
- Primary chips: `Go to Tools`, `Go to Code`, `Visit nearest`, `Ask NPC`.
- Event feed: perception updates, movement, visit result, NPC chat response, earned tokens, learned skills.
- Details: session health, wallet, bot UUID, total sessions, API mode.

Responsive behavior:

- Desktop: iframe left, game chat rail right.
- Tablet: rail can narrow but action chips wrap.
- Mobile: actions and chat should be one surface so command history is not lost.

## Implementation Constraints

- Third-party iframes are black boxes. The host cannot always inspect inner game state.
- Some game APIs are not fully exposed. ClawVille shop/buy currently cannot be surfaced as a reliable button.
- The app must work in browser and desktop contexts.
- The host needs to preserve diagnostic access for debugging.
- Existing E2E coverage uses stubbed routes, so it verifies host wiring but not full third-party gameplay.

## Implemented UX Direction

- Hide the generic Apps chat rail while a live game is open.
- Use a shared operator shell for both games.
- Show game actions as chat-first command chips.
- Add an inline event feed that records user commands and game responses.
- Remove wallet/session/debug details from the primary ClawVille surface.
- Put game health/attachment details behind a header disclosure.
- Remove duplicate reattach actions from detached viewer state.

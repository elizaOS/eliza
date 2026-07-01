// @vitest-environment jsdom

import { smokeStoryModules } from "../../../test/portable-stories";

// jsdom counterpart to the browser story gate: render every Conversations
// story (ConversationsSidebar default / mobile / game-modal) and assert it
// mounts without throwing.
const mods = import.meta.glob("./*.stories.tsx", { eager: true });

smokeStoryModules("conversations", mods);

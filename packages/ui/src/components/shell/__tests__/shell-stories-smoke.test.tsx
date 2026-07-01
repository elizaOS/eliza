// @vitest-environment jsdom
/**
 * Portable-stories smoke test for the shell surface. See test/portable-stories.tsx.
 * The overlay/startup stories that drive a live transcript sink or pairing input
 * need the full app runtime; those are skip-listed and covered by the browser
 * story gate (needs-runtime), the chat-sheet __e2e__ harness, and live audit:app.
 */
import { smokeStoryModules } from "../../../../test/portable-stories";

const modules = import.meta.glob("../**/*.stories.tsx", { eager: true });

smokeStoryModules("shell", modules, {
  minModules: 1,
  skip: [
    "ContinuousChatOverlay/Ambient",
    "ContinuousChatOverlay/PromptSuggestions",
    "ContinuousChatOverlay/Listening",
    "ContinuousChatOverlay/Responding",
    "ContinuousChatOverlay/Booting",
    "ContinuousChatOverlay/SlashCommands",
    "StartupScreen/Pairing",
  ],
});

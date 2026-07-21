/**
 * Coverage entrypoint for the Electrobun DesktopManager contract suite.
 *
 * The app-core Vitest config intentionally excludes tests physically located
 * under platforms/electrobun from its broad unit lane. Import the real suite
 * here so changed-file coverage executes the canonical native boundary rather
 * than replacing it with a browser notification double.
 */
// biome-ignore lint/correctness/noUnusedImports: Explicitly classifies this coverage entrypoint for the Vitest lane.
import {} from "vitest";
import "../platforms/electrobun/src/native/desktop-window.test";

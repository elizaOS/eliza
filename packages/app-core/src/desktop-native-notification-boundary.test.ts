/**
 * Coverage entrypoint for the Electrobun DesktopManager contract suite.
 *
 * The app-core Vitest config excludes tests physically located under
 * platforms/electrobun, so this entrypoint keeps the canonical native boundary
 * in the app-core test suite without replacing it with a browser double.
 */
// biome-ignore lint/correctness/noUnusedImports: Side-effect import registers the native boundary suite.
import {} from "vitest";
import "../platforms/electrobun/src/native/desktop-window.test";

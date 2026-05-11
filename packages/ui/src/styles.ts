// Renderer-only entry point for @elizaos/ui's bundled stylesheets.
// Apps that need the default UI stylesheets must import this module
// explicitly (e.g. `import "@elizaos/ui/styles"`). It is intentionally
// separate from `./index.ts` so that Node-side plugin loaders can
// import the UI barrel without triggering a CSS module evaluation
// (Node refuses ".css" extensions out of the box).
import "./styles/styles.css";
import "./styles/brand-gold.css";

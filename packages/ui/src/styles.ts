/**
 * Renderer-only entry point (`@elizaos/ui/styles`) for the package's bundled
 * stylesheets. Apps that want the default UI styles import this module
 * explicitly. Kept separate from `./index.ts` so Node-side plugin loaders can
 * import the UI barrel without triggering a CSS module evaluation (Node refuses
 * ".css" extensions out of the box).
 */
import "./styles/styles.css";
import "./styles/brand-gold.css";
import "./cloud-ui/index.css";

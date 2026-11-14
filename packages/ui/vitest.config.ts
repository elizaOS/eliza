import tailwindcss from "@tailwindcss/vite";
import { project } from "vibestack/testing/vitest";

/** The generated stories: mounted in happy-dom, and played with axe in Chromium. Behaviour is each story's `play`, in its `.meta.tsx`. */
export default project({ root: import.meta.dirname, plugins: [tailwindcss()] });

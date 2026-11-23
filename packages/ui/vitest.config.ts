import tailwindcss from "@tailwindcss/vite";
import { project } from "vibestack/testing/vitest";

export default project({ root: import.meta.dirname, plugins: [tailwindcss()] });

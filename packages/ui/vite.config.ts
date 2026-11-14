import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// What Storybook builds with; the tests share it through vitest.config.ts.
export default defineConfig({ plugins: [tailwindcss()] });

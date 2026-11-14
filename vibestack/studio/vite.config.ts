// The page (src/page/), built into dist/page/ for ./src/server.vibe to serve. Its styles are Tailwind on the
// repository's design tokens (@repo/design-system, through ../design/), and the components it shares with every interface (@repo/ui).
import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import vibelang from "vibelang-vite";
import { defineConfig, type Plugin } from "vite";
import { themeCss, tokensCss } from "../design/generate.ts";
import { parseTokens } from "../design/tokens.ts";
import raw from "@repo/design-system/tokens.json" with { type: "json" };

const here = path.dirname(fileURLToPath(import.meta.url));
const tokens = parseTokens(raw);
const THEME = path.join(here, "src/page/theme.css");
const ui = path.dirname(fileURLToPath(import.meta.resolve("@repo/ui")));

/** `virtual:studio-theme.css`: the design system's Tailwind theme and tokens, and the shared components' classes to scan. */
const theme = (): Plugin => ({
  name: "studio-theme",
  enforce: "pre",
  resolveId: (id) => (id === "virtual:studio-theme.css" ? THEME : undefined),
  load: (id) => (id === THEME ? `${themeCss(tokens).replace('@import "./tokens.css";', "")}\n${tokensCss(tokens)}\n@source "${ui}";\n` : undefined),
});

export default defineConfig({
  root: path.join(here, "src/page"),
  base: "./",
  plugins: [theme(), vibelang(), react(), tailwindcss()],
  build: { outDir: path.join(here, "dist/page"), emptyOutDir: true },
  logLevel: "warn",
});

// spec/cloud/returnPages.md, "Story: Bring me back to the app when its link did not open"; spec/cloud/returnPages.md, "Story: Tell a payer the checkout ended"
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import vibelang from "vibelang-vite";
import { createServer, defineConfig, type Plugin } from "vite";
import type { renderPages as RenderPages } from "./src/pages/render.tsx";

const buildProject = resolve(import.meta.dirname, "tsconfig.build.json");

const pages = (): Plugin => ({
  name: "cloud-pages",
  apply: "build",
  generateBundle: {
    order: "post",
    async handler(_, bundle) {
      const css = Object.values(bundle)
        .flatMap((output) => (output.type === "asset" && output.fileName.endsWith(".css") ? [typeof output.source === "string" ? output.source : new TextDecoder().decode(output.source)] : []))
        .join("");
      for (const fileName of Object.keys(bundle)) delete bundle[fileName];
      const server = await createServer({ configFile: false, root: import.meta.dirname, plugins: [vibelang({ project: buildProject })], appType: "custom", logLevel: "error", server: { middlewareMode: true, hmr: false, ws: false } });
      try {
        const { renderPages } = (await server.ssrLoadModule("/src/pages/render.tsx")) as { renderPages: typeof RenderPages };
        for (const page of renderPages(css)) this.emitFile({ type: "asset", fileName: page.fileName, source: page.source });
      } finally {
        await server.close();
      }
    },
  },
});

export default defineConfig({
  root: "src/pages",
  plugins: [vibelang({ project: buildProject }), tailwindcss(), pages()],
  build: { outDir: "../../dist/pages", emptyOutDir: true },
});

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const htmlPath = join(
  root,
  "Chat with Webpage",
  "Shared (App)",
  "Resources",
  "Base.lproj",
  "Main.html",
);
const cssPath = join(
  root,
  "Chat with Webpage",
  "Shared (App)",
  "Resources",
  "Style.css",
);

let html = readFileSync(htmlPath, "utf8");
html = html
  .replace("<html>", '<html lang="en">')
  .replace(
    '<button class="platform-mac open-preferences">',
    '<button type="button" class="platform-mac open-preferences">',
  );
writeFileSync(htmlPath, html);

let css = readFileSync(cssPath, "utf8");
css = css.replace(
  "font: -apple-system-short-body;",
  "font: -apple-system-short-body, sans-serif;",
);
writeFileSync(cssPath, css);

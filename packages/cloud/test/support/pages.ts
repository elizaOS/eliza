// spec/cloud/returnPages.md, "Story: Bring me back to the app when its link did not open"; spec/cloud/returnPages.md, "Story: Tell a payer the checkout ended"
import { existsSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { renderPages } from "../../src/pages/render.tsx";

const pagesDir = new URL("../../dist/pages/", import.meta.url);

export async function builtPages(): Promise<void> {
  const pages = renderPages("");
  if (pages.every((page) => existsSync(new URL(page.fileName, pagesDir)))) return;
  await mkdir(pagesDir, { recursive: true });
  for (const page of pages) {
    const target = new URL(page.fileName, pagesDir);
    if (existsSync(target)) continue;
    const scratch = new URL(`${page.fileName}.${process.pid}.tmp`, pagesDir);
    await writeFile(scratch, page.source, "utf8");
    await rename(scratch, target);
  }
}

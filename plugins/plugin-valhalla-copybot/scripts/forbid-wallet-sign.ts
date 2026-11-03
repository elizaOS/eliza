import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const FORBIDDEN = /\bsignTransaction\b|\bsignAllTransactions\b|\bsendTransaction\b|\bsignAndSendTransaction\b/;

const ROOTS = [
  "public",
  "extension",
  "mobile",
  "android/app/src/main/java",
  "src/wallet-client.ts",
  "src/live-balance.ts",
];

function filesIn(dir: string, out: string[]) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "vendor") continue;
    const full = path.join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) filesIn(full, out);
    else if (/\.(js|ts|tsx|java|html)$/.test(name)) out.push(full);
  }
}

export function findForbiddenWalletCalls(root: string): string[] {
  const hits: string[] = [];
  for (const rel of ROOTS) {
    const full = path.join(root, rel);
    const list: string[] = [];
    try {
      if (statSync(full).isDirectory()) filesIn(full, list);
      else list.push(full);
    } catch {
      continue;
    }
    for (const file of list) {
      const text = readFileSync(file, "utf8");
      if (FORBIDDEN.test(text)) hits.push(path.relative(root, file));
    }
  }
  return hits;
}

if (import.meta.main) {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const hits = findForbiddenWalletCalls(root);
  if (hits.length) {
    console.error(`Wallet sign or send call found:\n${hits.join("\n")}`);
    process.exit(1);
  }
  console.log("Wallet sign check passed");
}

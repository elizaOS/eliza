import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const FORBIDDEN = /\bsignTransaction\b|\bsignAllTransactions\b|\bsendTransaction\b|\bsignAndSendTransaction\b/;
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

function files(dir: string, out: string[]) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) files(full, out);
    else if (/\.(ts|js|html)$/.test(name) && !name.endsWith(".test.ts")) out.push(full);
  }
}

const list: string[] = [];
files(path.join(root, "src"), list);
const hits = list.filter((file) => FORBIDDEN.test(readFileSync(file, "utf8")));
if (hits.length) {
  console.error(hits.map((file) => path.relative(root, file)).join("\n"));
  process.exit(1);
}
console.log("Portal sign check passed");

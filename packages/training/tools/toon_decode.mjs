#!/usr/bin/env bun
/**
 * Legacy-only streaming TOON decoder for compatibility corpus validation.
 *
 * Native v5 tool-calling exports must be JSON and must not call this tool.
 *
 * Reads NDJSON {"toon": "<doc>"} from stdin and writes either
 * {"ok": true, "decoded": <obj>} or {"error": "<msg>"} per line.
 */

import { decode } from "@toon-format/toon";
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  if (!line.trim()) return;
  try {
    const value = JSON.parse(line);
    const decoded = decode(value.toon);
    process.stdout.write(JSON.stringify({ ok: true, decoded }) + "\n");
  } catch (e) {
    process.stdout.write(JSON.stringify({ error: String(e) }) + "\n");
  }
});

rl.on("close", () => process.exit(0));

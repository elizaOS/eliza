#!/usr/bin/env bun
/**
 * Streaming TOON decoder for the training pipeline (validation only).
 *
 * Reads NDJSON {"toon": "<doc>"} from stdin and writes either
 * {"ok": true, "decoded": <obj>} or {"error": "<msg>"} per line. Used
 * by the messaging-action synth verifier to assert the @toon-format/toon
 * runtime parses every emitted target.
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

#!/usr/bin/env bun
/**
 * verify-rpc-handlers — compare ElizaDesktopRPCSchema methods to handler
 * implementations in rpc-handlers.ts. Prints a drift report.
 *
 * Use during the defineRPC migration to catch missing/extra/orphan handlers.
 *
 * Usage:
 *   bun scripts/verify-rpc-handlers.ts
 *
 * Exit code: 0 if in sync, 1 if drift detected.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const PLATFORM_ROOT = resolve(import.meta.dir, "..");
const SCHEMA_PATH = resolve(PLATFORM_ROOT, "src/rpc-schema.ts");
const HANDLERS_PATH = resolve(PLATFORM_ROOT, "src/rpc-handlers.ts");

/** Extract top-level method names from `requests: { ... }` block in a schema side. */
function extractSchemaMethods(
	source: string,
	side: "bun" | "webview",
): Set<string> {
	const sideAnchor = `${side}: RPCSchema<{`;
	const sideStart = source.indexOf(sideAnchor);
	if (sideStart < 0) {
		throw new Error(`Could not find ${side} side in schema`);
	}
	const requestsAnchor = "requests: {";
	const requestsStart = source.indexOf(requestsAnchor, sideStart);
	if (requestsStart < 0) {
		throw new Error(`Could not find requests block in ${side} side`);
	}
	// Walk forward to matching closing brace.
	const cursor = requestsStart + requestsAnchor.length;
	let depth = 1;
	let i = cursor;
	while (i < source.length && depth > 0) {
		const ch = source[i];
		if (ch === "{") depth++;
		else if (ch === "}") depth--;
		i++;
	}
	const block = source.slice(cursor, i - 1);

	// Top-level keys: identifier followed by `:` at depth 0 inside block.
	const methods = new Set<string>();
	let d = 0;
	let lineStart = 0;
	for (let j = 0; j < block.length; j++) {
		const ch = block[j];
		if (ch === "{") d++;
		else if (ch === "}") d--;
		else if (ch === "\n") lineStart = j + 1;
		else if (ch === ":" && d === 0) {
			const line = block.slice(lineStart, j);
			const match = line.match(/^\s*([a-zA-Z_$][\w$]*)\s*$/);
			if (match) methods.add(match[1]);
		}
	}
	return methods;
}

/** Extract top-level handler keys from the buildBunRpcHandlers return block. */
function extractHandlerKeys(source: string): Set<string> {
	// Prefer the new pure factory; fall back to the legacy setRequestHandler call.
	const anchors = [
		"export function buildBunRpcHandlers",
		"rpc?.setRequestHandler?.({",
	];
	let cursor = -1;
	for (const anchor of anchors) {
		const idx = source.indexOf(anchor);
		if (idx < 0) continue;
		// For the factory, find the `return {` after the function signature.
		if (anchor.startsWith("export function")) {
			const returnIdx = source.indexOf("return {", idx);
			if (returnIdx < 0) continue;
			cursor = returnIdx + "return {".length;
		} else {
			cursor = idx + anchor.length;
		}
		break;
	}
	if (cursor < 0) {
		throw new Error(
			"Could not find handler block (buildBunRpcHandlers or setRequestHandler)",
		);
	}
	let depth = 1;
	let i = cursor;
	while (i < source.length && depth > 0) {
		const ch = source[i];
		if (ch === "{") depth++;
		else if (ch === "}") depth--;
		i++;
	}
	const block = source.slice(cursor, i - 1);

	const keys = new Set<string>();
	let d = 0;
	let parenDepth = 0;
	let lineStart = 0;
	for (let j = 0; j < block.length; j++) {
		const ch = block[j];
		if (ch === "{") d++;
		else if (ch === "}") d--;
		else if (ch === "(") parenDepth++;
		else if (ch === ")") parenDepth--;
		else if (ch === "\n") lineStart = j + 1;
		else if ((ch === ":" || ch === ",") && d === 0 && parenDepth === 0) {
			const line = block.slice(lineStart, j);
			// Property: identifier alone (shorthand) or identifier preceding colon.
			// For shorthand, the line is just the identifier (with whitespace).
			// For colon syntax, line ends with the identifier name.
			if (ch === ",") {
				const match = line.match(/^\s*([a-zA-Z_$][\w$]*)\s*$/);
				if (match) keys.add(match[1]);
			} else {
				const match = line.match(/^\s*([a-zA-Z_$][\w$]*)\s*$/);
				if (match) keys.add(match[1]);
			}
		}
	}
	return keys;
}

const schemaSrc = readFileSync(SCHEMA_PATH, "utf8");
const handlersSrc = readFileSync(HANDLERS_PATH, "utf8");

const schemaMethods = extractSchemaMethods(schemaSrc, "bun");
const handlerKeys = extractHandlerKeys(handlersSrc);

const missing = [...schemaMethods].filter((m) => !handlerKeys.has(m)).sort();
const extra = [...handlerKeys].filter((k) => !schemaMethods.has(k)).sort();

console.log(`Schema methods (bun.requests): ${schemaMethods.size}`);
console.log(`Handler implementations:       ${handlerKeys.size}`);
console.log("");

if (missing.length === 0 && extra.length === 0) {
	console.log("✓ All schema methods have handler implementations");
	console.log("✓ All handlers correspond to schema methods");
	process.exit(0);
}

if (missing.length > 0) {
	console.log(`✗ Missing handlers (${missing.length}):`);
	for (const m of missing) console.log(`    - ${m}`);
	console.log("");
}

if (extra.length > 0) {
	console.log(`✗ Orphan handlers — not in schema (${extra.length}):`);
	for (const k of extra) console.log(`    - ${k}`);
	console.log("");
}

process.exit(1);

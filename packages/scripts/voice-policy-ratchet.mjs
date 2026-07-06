#!/usr/bin/env node
/**
 * Diff-scoped guard against NEW hardcoded user-facing strings on agent reply
 * paths (#14873). The owner directive is absolute: response messages to the
 * user must read as if a real person wrote them - no hardcoded templates, no
 * canned status strings, no raw `error.message` - so every agent-voiced literal
 * must flow through the humanness voice gate (`ensureAgentVoice`) rather than be
 * emitted verbatim.
 *
 * The repo already contains many pre-existing hardcoded reply literals; a
 * repo-wide count-vs-baseline gate cannot work (it goes stale on any unrelated
 * develop merge). So enforcement is scoped to the diff, exactly like
 * `error-policy-ratchet.mjs`:
 *
 *   base = git merge-base origin/develop HEAD
 *   for each production source file the branch touches (base..HEAD):
 *     fail iff its CURRENT unannotated-reply-literal count is GREATER than the
 *     same file's count at base.
 *
 * A PR may not ADD an unannotated agent-voiced literal to the files it touches;
 * it is immune to drift in files it does not touch, and is a no-op on develop.
 *
 * A reply literal is a call to a reply-shaped callee (callback / reply / send /
 * sendMessageToTarget / routeAutonomyTextToUser / channel.send / ctx.reply)
 * whose argument is either a bare string literal or an object literal with a
 * string-literal `text:` property that is NOT marked `agentVoiced: true`.
 * Classification is via the TypeScript AST so tokens in comments/other strings
 * never miscount.
 *
 * Escape hatch: annotate the call site with `// voice-policy:V<N> <reason>` on
 * the finding line or the line directly above it (V1 fail-open delivery, V2
 * owner's own words, V3 already model-voiced, V4 designed literal surface, V5
 * non-agent system status). Two files are allowlisted as designed literal
 * surfaces: the tutorial script (must match observations deterministically) and
 * the boot-status indicator (system status, not agent speech).
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const ROOT = path.resolve(import.meta.dirname, "../..");

// Callee names (final identifier of an identifier or property-access call) that
// deliver text to a user. `send` is broad but the object/string-literal +
// unannotated filter keeps the false-positive rate low in practice.
const REPLY_CALLEES = new Set([
	"callback",
	"reply",
	"send",
	"sendMessage",
	"sendMessageToTarget",
	"routeAutonomyTextToUser",
]);

// Designed literal surfaces that are exempt whole-file: scripted tutorial steps
// must match observations verbatim, and the boot-status indicator renders
// third-person system status ("Waking ...") that is not agent speech.
const ALLOWLIST_BASENAMES = new Set([
	"tutorial-script.ts",
	"BootStatusIndicator.tsx",
]);

const EXCLUDED_SEGMENTS = new Set([
	"__fixtures__",
	"__mocks__",
	"__tests__",
	"fixtures",
	"generated",
	"mock",
	"mocks",
	"test",
	"tests",
]);

const args = new Set(process.argv.slice(2));
const JSON_FLAG = args.has("--json");
const SELF_TEST = args.has("--self-test");
const REPORT = args.has("--report");

function usage() {
	console.log(`Usage: node packages/scripts/voice-policy-ratchet.mjs [options]

Diff-scoped: fails only when a production source file the branch touches
increases its own count of unannotated agent-voiced reply literals vs the
merge-base with origin/develop. Immune to unrelated develop drift.

Options:
  --json        Print machine-readable diff-scoped result JSON.
  --report      Also compute + print the repo-wide total (informational only).
  --self-test   Run the AST classifier self-test.

Env:
  VOICE_POLICY_BASE_REF  Override the base ref (default: origin/develop, then develop).
`);
}

if (args.has("--help") || args.has("-h")) {
	usage();
	process.exit(0);
}

function isProductionSourceFile(relPath) {
	if (!/\.(ts|tsx)$/.test(relPath)) return false;
	if (/\.d\.ts$/.test(relPath)) return false;
	if (!relPath.startsWith("src/") && !relPath.includes("/src/")) return false;

	const parts = relPath.split("/");
	if (parts.some((part) => EXCLUDED_SEGMENTS.has(part))) return false;

	const base = path.basename(relPath);
	if (/\.(test|spec|e2e|stories?|fixture|mock)\.(ts|tsx)$/.test(base)) {
		return false;
	}
	if (ALLOWLIST_BASENAMES.has(base)) return false;
	return true;
}

function sourceFileKind(relPath) {
	return relPath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

function calleeName(expr) {
	if (ts.isIdentifier(expr)) return expr.text;
	if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
	return null;
}

/**
 * True when a node's value is (partly) a hardcoded string: a plain string
 * literal, a template literal (with or without `${…}` substitutions - the
 * `\`oops: ${error.message}\`` raw-error-leak shape is the whole point), or a
 * string concatenation containing one. A bare identifier or a variable holding
 * already-voiced text is NOT a literal and is ignored.
 */
function isStringLiteralish(node) {
	if (!node) return false;
	if (ts.isStringLiteral(node)) return true;
	if (ts.isNoSubstitutionTemplateLiteral(node)) return true;
	if (ts.isTemplateExpression(node)) return true;
	if (ts.isParenthesizedExpression(node)) return isStringLiteralish(node.expression);
	if (
		ts.isBinaryExpression(node) &&
		node.operatorToken.kind === ts.SyntaxKind.PlusToken
	) {
		return isStringLiteralish(node.left) || isStringLiteralish(node.right);
	}
	return false;
}

/** True when an object literal has a string-literal `text:` property and is NOT
 *  marked `agentVoiced: true`. Object args without a `text` field are ignored. */
function objectHasUnvoicedTextLiteral(node) {
	if (!ts.isObjectLiteralExpression(node)) return false;
	let hasTextLiteral = false;
	let markedVoiced = false;
	for (const prop of node.properties) {
		if (!ts.isPropertyAssignment(prop) || !prop.name) continue;
		const name = ts.isIdentifier(prop.name)
			? prop.name.text
			: ts.isStringLiteral(prop.name)
				? prop.name.text
				: null;
		if (name === "text" && isStringLiteralish(prop.initializer)) {
			hasTextLiteral = true;
		}
		if (
			name === "agentVoiced" &&
			prop.initializer.kind === ts.SyntaxKind.TrueKeyword
		) {
			markedVoiced = true;
		}
	}
	return hasTextLiteral && !markedVoiced;
}

/**
 * Classify one source file's text into reply-literal findings. Exported for the
 * self-test. Each finding is a reply-shaped call carrying an unannotated
 * user-facing literal.
 */
export function collectFindings(sourceText, relPath) {
	const sourceFile = ts.createSourceFile(
		relPath,
		sourceText,
		ts.ScriptTarget.Latest,
		true,
		sourceFileKind(relPath),
	);
	const lines = sourceText.split("\n");
	const findings = [];

	// A finding is annotated when its line, or the line directly above, carries a
	// `voice-policy:V<N>` escape comment.
	function isAnnotated(lineIndex) {
		for (const idx of [lineIndex, lineIndex - 1, lineIndex - 2]) {
			if (idx >= 0 && idx < lines.length && /voice-policy:V\d/.test(lines[idx])) {
				return true;
			}
		}
		return false;
	}

	function record(node) {
		const pos = sourceFile.getLineAndCharacterOfPosition(
			node.getStart(sourceFile),
		);
		if (isAnnotated(pos.line)) return;
		findings.push({ file: relPath, line: pos.line + 1 });
	}

	function visit(node) {
		if (ts.isCallExpression(node)) {
			const name = calleeName(node.expression);
			if (name && REPLY_CALLEES.has(name)) {
				for (const arg of node.arguments) {
					if (isStringLiteralish(arg) || objectHasUnvoicedTextLiteral(arg)) {
						record(node);
						break;
					}
				}
			}
		}
		ts.forEachChild(node, visit);
	}

	visit(sourceFile);
	return findings;
}

function countText(sourceText, relPath) {
	return collectFindings(sourceText, relPath).length;
}

function git(argv, { allowFailure = false } = {}) {
	try {
		return execFileSync("git", argv, {
			cwd: ROOT,
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
			stdio: ["ignore", "pipe", allowFailure ? "ignore" : "inherit"],
		});
	} catch (err) {
		if (allowFailure) return null;
		throw err;
	}
}

function resolveBaseRef() {
	const candidates = [
		process.env.VOICE_POLICY_BASE_REF,
		"origin/develop",
		"develop",
	].filter(Boolean);
	for (const ref of candidates) {
		if (
			git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
				allowFailure: true,
			})
		) {
			return ref;
		}
	}
	return null;
}

function mergeBaseWith(ref) {
	const out = git(["merge-base", ref, "HEAD"], { allowFailure: true });
	return out ? out.trim() : null;
}

function changedProductionFiles(base) {
	const out = git(["diff", "--name-only", "-z", `${base}`, "HEAD"], {
		allowFailure: true,
	});
	if (!out) return [];
	return [...new Set(out.split("\0").filter(Boolean))]
		.filter(isProductionSourceFile)
		.sort();
}

function baseContent(base, relPath) {
	return git(["show", `${base}:${relPath}`], { allowFailure: true });
}

function workingTreeContent(relPath) {
	try {
		return readFileSync(path.join(ROOT, relPath), "utf8");
	} catch {
		return null;
	}
}

/** For each changed file, compare working-tree finding count to the base count.
 *  New files compare against zero. Only an increase is a regression. */
function diffScopedRegressions(base, files) {
	const perFile = [];
	const regressions = [];
	for (const relPath of files) {
		const currentText = workingTreeContent(relPath);
		if (currentText === null) continue;
		const current = countText(currentText, relPath);

		const baseText = baseContent(base, relPath);
		const baseCount = baseText === null ? 0 : countText(baseText, relPath);

		perFile.push({ file: relPath, current, base: baseCount });
		if (current > baseCount) {
			regressions.push({ file: relPath, current, base: baseCount });
		}
	}
	return { perFile, regressions };
}

function repoWideTotal() {
	const output = git(["ls-files"]);
	const files = [...new Set(output.split("\n").filter(Boolean))].filter(
		isProductionSourceFile,
	);
	let total = 0;
	for (const relPath of files) {
		total += countText(readFileSync(path.join(ROOT, relPath), "utf8"), relPath);
	}
	return { filesScanned: files.length, total };
}

function printHumanSummary({ baseRef, base, files, perFile, regressions }) {
	console.log(
		`[voice-policy-ratchet] base ${baseRef} (${base.slice(0, 10)}); ${files.length} changed production source file(s)`,
	);
	for (const row of perFile) {
		if (row.current !== row.base) {
			console.log(
				`[voice-policy-ratchet]   ${row.file}: reply-literals ${row.base}->${row.current}`,
			);
		}
	}
	if (regressions.length === 0) {
		console.log(
			"[voice-policy-ratchet] no new hardcoded reply literals in touched files",
		);
		return;
	}
	console.error(
		"[voice-policy-ratchet] new hardcoded agent-voiced literals added in touched files:",
	);
	for (const r of regressions) {
		console.error(`  - ${r.file}: reply-literals ${r.base} -> ${r.current}`);
	}
	console.error(
		"\nUser-facing reply text must flow through the humanness voice gate (`ensureAgentVoice`), not be hardcoded. Route the literal through the gate, mark it `agentVoiced: true` when it is already the agent's/owner's own words, or annotate the call site `// voice-policy:V<N> <reason>`. See the humanness voice-gate policy (#14873) and packages/core/src/services/message/voice-gate.ts.",
	);
}

function runSelfTest() {
	const sample = `
    function a(callback) {
      callback({ text: "hardcoded reply" });
      callback({ text: rephrased, agentVoiced: true });
      callback({ text: "owner words", agentVoiced: true });
      runtime.sendMessageToTarget(target, { text: "raw error " + msg });
      routeAutonomyTextToUser(state, "literal proactive");
      ctx.reply("please try again");
      // voice-policy:V4 designed literal surface
      callback({ text: "annotated and skipped" });
      const notReply = { text: "just data" };
      compute({ text: "not a reply callee" });
    }
  `;
	const findings = collectFindings(sample, "packages/agent/src/sample.ts");
	// Expected findings: hardcoded reply, raw error, literal proactive, ctx.reply.
	// Skipped: the two agentVoiced objects, the annotated one, the non-reply
	// callee object, and the plain data object.
	const expected = 4;
	if (findings.length !== expected) {
		console.error(
			`[voice-policy-ratchet] self-test failed: expected ${expected} findings, got ${findings.length}: ${JSON.stringify(findings)}`,
		);
		process.exit(1);
	}

	// Allowlisted + excluded files are dropped at file selection, so they never
	// reach the classifier.
	if (isProductionSourceFile("packages/app/src/tutorial-script.ts")) {
		console.error(
			"[voice-policy-ratchet] self-test failed: allowlist not honored",
		);
		process.exit(1);
	}
	if (isProductionSourceFile("packages/agent/src/foo.test.ts")) {
		console.error(
			"[voice-policy-ratchet] self-test failed: test file treated as production",
		);
		process.exit(1);
	}
	console.log("[voice-policy-ratchet] self-test passed");
}

if (SELF_TEST) {
	runSelfTest();
	process.exit(0);
}

const baseRef = resolveBaseRef();
const base = baseRef ? mergeBaseWith(baseRef) : null;

if (!base) {
	const reason = baseRef
		? `no merge-base with ${baseRef}`
		: "no base ref (origin/develop) resolvable";
	const repoWide = REPORT ? repoWideTotal() : null;
	if (JSON_FLAG) {
		console.log(
			JSON.stringify(
				{ ok: true, skipped: reason, baseRef, mergeBase: null, repoWide },
				null,
				2,
			),
		);
	} else {
		console.log(
			`[voice-policy-ratchet] ${reason}; diff-scoped check skipped (pass)`,
		);
		if (repoWide) {
			console.log(
				`[voice-policy-ratchet] repo-wide (informational): ${repoWide.total} unannotated reply literals across ${repoWide.filesScanned} files`,
			);
		}
	}
	process.exit(0);
}

const files = changedProductionFiles(base);
const { perFile, regressions } = diffScopedRegressions(base, files);
const repoWide = REPORT ? repoWideTotal() : null;

if (JSON_FLAG) {
	console.log(
		JSON.stringify(
			{
				ok: regressions.length === 0,
				baseRef,
				mergeBase: base,
				changedFiles: files,
				perFile,
				regressions,
				repoWide,
			},
			null,
			2,
		),
	);
} else {
	printHumanSummary({ baseRef, base, files, perFile, regressions });
	if (repoWide) {
		console.log(
			`[voice-policy-ratchet] repo-wide (informational): ${repoWide.total} unannotated reply literals across ${repoWide.filesScanned} files`,
		);
	}
}

if (regressions.length > 0) process.exit(1);

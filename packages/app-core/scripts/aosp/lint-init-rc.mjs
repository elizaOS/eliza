#!/usr/bin/env node
// Lints an Android init.rc file against the documented init language.
//
// Catches typos that AOSP's init parser would only surface at boot time
// (e.g. `on bootp`, `setpro foo bar`, missing exec-shell quoting).
//
// Reference: https://android.googlesource.com/platform/system/core/+/master/init/README.md
//
// Usage:
//   node eliza/packages/app-core/scripts/aosp/lint-init-rc.mjs <FILE> [<FILE>...]
//
// Generic — knows nothing about the AOSP variant config. Callers pass
// any path; the linter only inspects the file's syntax.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// init.cpp recognises specific top-level section keywords. Any other
// keyword at column zero is a syntax error at boot.
const TOP_LEVEL_KEYWORDS = new Set(["on", "service", "import", "subsystem"]);

// `on <event>` event names. Not exhaustive — init also supports
// property triggers (`on property:foo=bar`) and AND-combined triggers
// (`on boot && property:foo=bar`). The validator below handles those.
const ON_EVENTS = new Set([
  "early-init",
  "init",
  "late-init",
  "early-fs",
  "fs",
  "post-fs",
  "post-fs-data",
  "late-fs",
  "boot",
  "charger",
  "fs-encryption-init-user-0",
  "post-fs-data-init-user-0",
  "shutdown",
  "userspace-reboot-requested",
  "early-boot",
  "load-persist-props-action",
]);

// Recognised commands inside `on` / `service` blocks. Init has more
// (e.g. `bootchart`, `class_reset`), but this list catches the most
// common typos. Unknown commands warn but don't fail — init drops
// unknown commands at parse time with a logcat warning, not a halt.
const KNOWN_COMMANDS = new Set([
  "bootchart",
  "chmod",
  "chown",
  "class_reset",
  "class_restart",
  "class_start",
  "class_stop",
  "copy",
  "domainname",
  "enable",
  "exec",
  "exec_background",
  "exec_start",
  "export",
  "hostname",
  "ifup",
  "insmod",
  "load_system_props",
  "load_persist_props",
  "loglevel",
  "mark_post_data",
  "mkdir",
  "mount",
  "mount_all",
  "perform_apex_config",
  "powerctl",
  "restart",
  "restorecon",
  "restorecon_recursive",
  "rm",
  "rmdir",
  "setprop",
  "setrlimit",
  "start",
  "stop",
  "swapon_all",
  "symlink",
  "sysclktz",
  "trigger",
  "umount",
  "umount_all",
  "verity_load_state",
  "verity_update_state",
  "wait",
  "wait_for_prop",
  "write",
  // Vendor-extension common verbs
  "init_user0",
  "remount_userdata",
]);

export function lintInitRc(filePath) {
  const issues = [];
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split(/\r?\n/);

  let inBlock = false;
  let currentBlockKind = null;
  let lastBlockHeaderLine = 0;

  lines.forEach((rawLine, index) => {
    const lineNumber = index + 1;
    const stripped = rawLine.replace(/\r$/, "");
    const trimmed = stripped.trim();

    if (!trimmed || trimmed.startsWith("#")) return;

    const indented = /^[ \t]/.test(stripped);
    if (!indented) {
      // Top-level directive starts a new block.
      const [keyword, ...rest] = trimmed.split(/\s+/);
      if (!TOP_LEVEL_KEYWORDS.has(keyword)) {
        issues.push({
          line: lineNumber,
          message: `unknown top-level keyword "${keyword}" — expected one of ${[...TOP_LEVEL_KEYWORDS].join(", ")}`,
        });
        inBlock = false;
        return;
      }
      currentBlockKind = keyword;
      lastBlockHeaderLine = lineNumber;
      inBlock = true;

      if (keyword === "on") {
        if (rest.length === 0) {
          issues.push({
            line: lineNumber,
            message: "`on` requires a trigger expression",
          });
          return;
        }
        // Trigger may be `event` or `property:foo=bar` or combined with
        // `&&`. Validate each clause.
        const triggerExpr = rest.join(" ");
        const clauses = triggerExpr.split(/\s*&&\s*/);
        for (const clause of clauses) {
          if (clause.startsWith("property:")) {
            if (!/^property:[^=]+=/.test(clause)) {
              issues.push({
                line: lineNumber,
                message: `malformed property trigger "${clause}" — expected property:<name>=<value>`,
              });
            }
          } else if (!ON_EVENTS.has(clause)) {
            issues.push({
              line: lineNumber,
              message: `unknown init event "${clause}" — expected one of ${[...ON_EVENTS].slice(0, 6).join(", ")}, ...`,
            });
          }
        }
      }
      return;
    }

    // Indented line — must be a command inside a block.
    if (!inBlock) {
      issues.push({
        line: lineNumber,
        message: "indented command outside any on/service block",
      });
      return;
    }

    const [command] = trimmed.split(/\s+/);
    if (currentBlockKind === "on" && !KNOWN_COMMANDS.has(command)) {
      issues.push({
        line: lineNumber,
        message: `unknown init command "${command}" (block opened at line ${lastBlockHeaderLine}); typos here only fail at boot`,
        soft: true,
      });
    }

    // Common typo class: `setprop foo` with no value.
    if (command === "setprop") {
      const parts = trimmed.split(/\s+/);
      if (parts.length < 3) {
        issues.push({
          line: lineNumber,
          message: `setprop requires <name> <value>; got ${parts.length - 1} arg(s)`,
        });
      }
    }

    // exec/exec_background must have a recognised user/group prefix.
    if (command === "exec" || command === "exec_background") {
      const parts = trimmed.split(/\s+/).slice(1);
      if (parts[0] !== "-" && !/^[a-z][\w.-]*$/.test(parts[0] ?? "")) {
        issues.push({
          line: lineNumber,
          message: `exec requires "- <user> <group> -- <argv>" (use - for "no seclabel")`,
        });
      }
      if (!trimmed.includes("--")) {
        issues.push({
          line: lineNumber,
          message: `exec missing argv separator "--"`,
          soft: true,
        });
      }
    }
  });

  return issues;
}

function formatIssue(issue, filePath) {
  const tag = issue.soft ? "WARN" : "ERROR";
  return `${filePath}:${issue.line}: [${tag}] ${issue.message}`;
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    console.log(
      "Usage: node eliza/packages/app-core/scripts/aosp/lint-init-rc.mjs <FILE> [<FILE> ...]",
    );
    process.exit(argv.length === 0 ? 1 : 0);
  }
  let hardErrors = 0;
  for (const filePath of argv) {
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) {
      console.error(`${resolved}: file not found`);
      hardErrors += 1;
      continue;
    }
    const issues = lintInitRc(resolved);
    for (const issue of issues) {
      const text = formatIssue(issue, resolved);
      if (issue.soft) {
        console.warn(text);
      } else {
        console.error(text);
        hardErrors += 1;
      }
    }
    if (issues.length === 0) {
      console.log(`${resolved}: OK`);
    }
  }
  process.exit(hardErrors > 0 ? 1 : 0);
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  await main();
}

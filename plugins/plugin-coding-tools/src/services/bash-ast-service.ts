import { type IAgentRuntime, Service, logger as coreLogger } from "@elizaos/core";
import { BASH_AST_SERVICE, CODING_TOOLS_LOG_PREFIX } from "../types.js";

/**
 * AST-based bash command analysis. Replaces the regex denylist tier in
 * SandboxService.validateCommand for anything more nuanced than `rm -rf /`.
 *
 * Catches:
 *   - Env-var hijacks (LD_PRELOAD=, DYLD_*, NODE_OPTIONS, PYTHONPATH, etc.)
 *     — both as command prefix (`LD_PRELOAD=x cmd`) and via `env` wrapper.
 *   - eval, source, . (dot) — arbitrary code from unverified input.
 *   - Privilege escalation: sudo, doas, su, pkexec, runuser.
 *   - Pipe-to-shell: `... | sh`, `curl x | bash`, etc. (after stripping
 *     leading wrappers on the right-hand side).
 *   - Wrapper stripping: timeout/nice/nohup/ionice/env/command/exec — the
 *     analyzer continues into the inner command and re-checks.
 *   - Dangerous redirects: writes to /etc, /dev/sd*, /boot, /usr/{s,}bin,
 *     /System, /Library/Launch{Daemons,Agents}.
 *   - Recursively analyzes command substitutions ($(...), backticks) and
 *     process substitutions (<(...), >(...)).
 *
 * Backed by mvdan-sh — the JS/WASM port of mvdan/sh, the same parser
 * Anthropic's Claude Code uses for its bash sandbox. Heavy (~500KB) so we
 * lazy-load the module on first analyze() call rather than at start().
 */

export type AstSeverity = "block" | "warn";

export type AstCategory =
  | "env_hijack"
  | "eval_source"
  | "pipe_to_shell"
  | "wrapper_strip"
  | "dangerous_redirect"
  | "privilege_escalation"
  | "command_substitution"
  | "process_substitution"
  | "parse_error";

export interface AstFinding {
  severity: AstSeverity;
  category: AstCategory;
  message: string;
  evidence?: string;
}

export interface AnalyzeResult {
  ok: boolean;
  findings: AstFinding[];
}

const HIJACK_VARS = new Set([
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "LD_AUDIT",
  "LD_BIND_NOW",
  "LD_DEBUG",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_FORCE_FLAT_NAMESPACE",
  "DYLD_LIBRARY_PATH",
  "DYLD_FALLBACK_LIBRARY_PATH",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PYTHONSTARTUP",
  "PYTHONPATH",
  "PERL5LIB",
  "PERL5OPT",
  "RUBYOPT",
  "RUBYLIB",
  "GIT_SSH_COMMAND",
  "GIT_PAGER",
  "GIT_EDITOR",
  "GIT_CONFIG_PARAMETERS",
  "BASH_ENV",
  "ENV",
]);

const SHELL_BINARIES = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "ash",
  "fish",
  "/bin/sh",
  "/bin/bash",
  "/bin/zsh",
  "/bin/dash",
  "/bin/ksh",
  "/usr/bin/sh",
  "/usr/bin/bash",
  "/usr/bin/zsh",
  "/usr/bin/env",
]);

const PRIV_ESC_COMMANDS = new Set([
  "sudo",
  "doas",
  "su",
  "pkexec",
  "runuser",
]);

const EVAL_LIKE_COMMANDS = new Set(["eval", "source", "."]);

const WRAPPER_COMMANDS = new Set([
  "timeout",
  "nice",
  "ionice",
  "nohup",
  "env",
  "command",
  "exec",
  "stdbuf",
  "unbuffer",
  "script",
]);

const DANGEROUS_FILE_PATHS: RegExp[] = [
  /^\/etc(\/|$)/,
  /^\/dev\/(?:sd|nvme|disk|hd|md|mmcblk)/,
  /^\/boot(\/|$)/,
  /^\/usr\/(?:bin|sbin|local\/bin|local\/sbin)(\/|$)/,
  /^\/System(\/|$)/,
  /^\/Library\/(?:LaunchDaemons|LaunchAgents)(\/|$)/,
  /^\/private\/etc(\/|$)/,
  /^\/var\/(?:db|root)(\/|$)/,
];

interface MvdanSh {
  syntax: {
    NewParser: () => MvdanParser;
    NodeType: (n: unknown) => string;
    Walk: (file: unknown, fn: (node: unknown) => boolean) => void;
  };
}

interface MvdanParser {
  Parse: (src: string, name: string) => unknown;
}

export class BashAstService extends Service {
  static serviceType = BASH_AST_SERVICE;
  capabilityDescription =
    "AST-based bash command analyzer. Catches env hijacks, eval, pipe-to-shell, dangerous redirects, and recursively analyzes substitutions.";

  private mvdan: MvdanSh | undefined;
  private parser: MvdanParser | undefined;
  private loadAttempted = false;

  static async start(runtime: IAgentRuntime): Promise<BashAstService> {
    const svc = new BashAstService(runtime);
    coreLogger.debug(`${CODING_TOOLS_LOG_PREFIX} BashAstService started`);
    return svc;
  }

  async stop(): Promise<void> {
    this.mvdan = undefined;
    this.parser = undefined;
  }

  private async ensureLoaded(): Promise<boolean> {
    if (this.parser) return true;
    if (this.loadAttempted) return false;
    this.loadAttempted = true;
    try {
      const mod = (await import("mvdan-sh")) as unknown as MvdanSh & { default?: MvdanSh };
      const sh = (mod.default ?? mod) as MvdanSh;
      if (!sh?.syntax?.NewParser) {
        coreLogger.warn(
          `${CODING_TOOLS_LOG_PREFIX} mvdan-sh module shape unexpected; AST analysis disabled`,
        );
        return false;
      }
      this.mvdan = sh;
      this.parser = sh.syntax.NewParser();
      return true;
    } catch (err) {
      coreLogger.warn(
        `${CODING_TOOLS_LOG_PREFIX} mvdan-sh failed to load; AST analysis disabled: ${(err as Error).message}`,
      );
      return false;
    }
  }

  /**
   * Analyze a shell command. Returns findings; `ok` is false when ANY finding
   * has severity "block".
   *
   * If mvdan-sh is unavailable for any reason, returns ok=true with a warn
   * finding so the caller can decide whether to fall back to the regex tier
   * alone.
   */
  async analyze(command: string): Promise<AnalyzeResult> {
    const loaded = await this.ensureLoaded();
    if (!loaded || !this.mvdan || !this.parser) {
      return {
        ok: true,
        findings: [
          {
            severity: "warn",
            category: "parse_error",
            message: "AST analyzer unavailable; relying on regex denylist only.",
          },
        ],
      };
    }
    let file: unknown;
    try {
      file = this.parser.Parse(command, "command.sh");
    } catch (err) {
      return {
        ok: false,
        findings: [
          {
            severity: "block",
            category: "parse_error",
            message: `Failed to parse command: ${(err as Error).message}`,
          },
        ],
      };
    }
    const findings: AstFinding[] = [];
    this.walk(file, findings);
    const ok = !findings.some((f) => f.severity === "block");
    return { ok, findings };
  }

  private walk(rootNode: unknown, findings: AstFinding[]): void {
    if (!this.mvdan) return;
    const syntax = this.mvdan.syntax;
    syntax.Walk(rootNode, (node) => {
      if (!node) return true;
      const kind = syntax.NodeType(node);
      switch (kind) {
        case "CallExpr":
          this.checkCallExpr(node, findings);
          break;
        case "BinaryCmd":
          this.checkBinaryCmd(node, findings);
          break;
        case "Redirect":
          this.checkRedirect(node, findings);
          break;
        case "ProcSubst":
          // syntax.Walk descends into ProcSubst.Stmts automatically. Note
          // its presence — the inner statements get checked normally.
          findings.push({
            severity: "warn",
            category: "process_substitution",
            message:
              "Process substitution (<(...) or >(...)) detected; inner commands are validated separately.",
          });
          break;
        case "CmdSubst":
          // syntax.Walk descends into CmdSubst.Stmts automatically too.
          findings.push({
            severity: "warn",
            category: "command_substitution",
            message:
              "Command substitution ($(...) or backtick) detected; inner commands are validated separately.",
          });
          break;
        default:
          break;
      }
      return true;
    });
  }

  private checkCallExpr(node: unknown, findings: AstFinding[]): void {
    const call = node as { Assigns?: Array<{ Name?: { Value?: string } }>; Args?: unknown[] };
    for (const assign of call.Assigns ?? []) {
      const name = assign.Name?.Value;
      if (typeof name === "string" && HIJACK_VARS.has(name)) {
        findings.push({
          severity: "block",
          category: "env_hijack",
          message: `Inline assignment ${name}=… can hijack process loading; not permitted.`,
          evidence: `${name}=…`,
        });
      }
    }

    if (!this.mvdan) return;
    const args = (call.Args ?? []).map((w) => extractLiteralWord(w, this.mvdan!.syntax));
    if (args.length === 0) return;

    let inner = args.slice();
    let stripped: string[] = [];
    while (inner.length > 0 && WRAPPER_COMMANDS.has(inner[0]!)) {
      const cmd = inner[0]!;
      stripped.push(cmd);
      if (cmd === "env") {
        let i = 1;
        while (i < inner.length && /^[A-Z_][A-Z0-9_]*=/.test(inner[i]!)) {
          const eq = inner[i]!.indexOf("=");
          const varName = inner[i]!.slice(0, eq);
          if (HIJACK_VARS.has(varName)) {
            findings.push({
              severity: "block",
              category: "env_hijack",
              message: `env-prefixed ${varName} can hijack process loading.`,
              evidence: inner[i],
            });
          }
          i++;
        }
        inner = inner.slice(i);
      } else if (cmd === "timeout") {
        // `timeout [OPTION] DURATION CMD ARG…` — drop options + duration.
        let i = 1;
        while (i < inner.length && inner[i]!.startsWith("-")) i++;
        if (i < inner.length) i++; // drop duration
        inner = inner.slice(i);
      } else if (cmd === "nice") {
        // `nice [-n N | -N] cmd …` — best-effort drop of the priority.
        let i = 1;
        if (i < inner.length && inner[i] === "-n") i += 2;
        else if (i < inner.length && inner[i]!.startsWith("-")) i += 1;
        inner = inner.slice(i);
      } else if (cmd === "command" || cmd === "exec") {
        // `command [-pVv] cmd args…` — drop flags.
        let i = 1;
        while (i < inner.length && inner[i]!.startsWith("-")) i++;
        inner = inner.slice(i);
      } else {
        inner = inner.slice(1);
      }
    }

    if (stripped.length > 0) {
      // Surface the stripping so reviewers see what we did.
      findings.push({
        severity: "warn",
        category: "wrapper_strip",
        message: `Stripped wrapper(s) ${stripped.join(", ")} before evaluating inner command.`,
      });
    }

    if (inner.length === 0) return;
    const realCmd = inner[0]!;

    if (PRIV_ESC_COMMANDS.has(realCmd)) {
      findings.push({
        severity: "block",
        category: "privilege_escalation",
        message: `${realCmd} attempts privilege escalation; not permitted.`,
        evidence: realCmd,
      });
    }

    if (EVAL_LIKE_COMMANDS.has(realCmd)) {
      findings.push({
        severity: "block",
        category: "eval_source",
        message: `${realCmd} can execute arbitrary code from unvetted input; not permitted.`,
        evidence: realCmd,
      });
    }
  }

  private checkBinaryCmd(node: unknown, findings: AstFinding[]): void {
    const bc = node as { Y?: { Cmd?: unknown } };
    const cmd = bc.Y?.Cmd;
    if (!cmd || !this.mvdan) return;
    const kind = this.mvdan.syntax.NodeType(cmd);
    if (kind !== "CallExpr") return;
    const args = ((cmd as { Args?: unknown[] }).Args ?? []).map((w) =>
      extractLiteralWord(w, this.mvdan!.syntax),
    );
    if (args.length === 0) return;
    let first = args[0]!;
    // Strip wrappers on the right-hand side too: `... | sudo bash`.
    let i = 0;
    while (i < args.length && WRAPPER_COMMANDS.has(args[i]!)) {
      i++;
      if (args[i - 1] === "timeout" && i < args.length) i++;
      if (args[i - 1] === "nice" && i < args.length && args[i] === "-n") i += 2;
    }
    if (i < args.length) first = args[i]!;

    if (SHELL_BINARIES.has(first)) {
      findings.push({
        severity: "block",
        category: "pipe_to_shell",
        message: `Piping output into ${first} executes arbitrary upstream content; not permitted.`,
        evidence: `… | ${first}`,
      });
    }
    if (PRIV_ESC_COMMANDS.has(first)) {
      // `cmd | sudo bash`: sudo is escalation regardless of pipe semantics.
      findings.push({
        severity: "block",
        category: "privilege_escalation",
        message: `Pipeline target ${first} attempts privilege escalation.`,
        evidence: `… | ${first}`,
      });
    }
  }

  private checkRedirect(node: unknown, findings: AstFinding[]): void {
    const r = node as { Word?: unknown };
    if (!this.mvdan || !r.Word) return;
    const target = extractLiteralWord(r.Word, this.mvdan.syntax);
    if (!target.startsWith("/")) return;
    for (const pat of DANGEROUS_FILE_PATHS) {
      if (pat.test(target)) {
        findings.push({
          severity: "block",
          category: "dangerous_redirect",
          message: `Redirect target ${target} is in a system-protected location.`,
          evidence: target,
        });
        return;
      }
    }
  }
}

function extractLiteralWord(word: unknown, syntax: MvdanSh["syntax"]): string {
  // Best-effort literal extraction. Non-literal parts (CmdSubst, ParamExp,
  // ArithmExp) are surfaced as `<dynamic>` so callers know to treat the word
  // as unsafe for path/command matching.
  if (!word) return "";
  const w = word as { Parts?: unknown[] };
  let result = "";
  for (const part of w.Parts ?? []) {
    const kind = syntax.NodeType(part);
    if (kind === "Lit") {
      result += (part as { Value?: string }).Value ?? "";
    } else if (kind === "SglQuoted") {
      result += (part as { Value?: string }).Value ?? "";
    } else if (kind === "DblQuoted") {
      for (const inner of ((part as { Parts?: unknown[] }).Parts ?? [])) {
        const ikind = syntax.NodeType(inner);
        if (ikind === "Lit") {
          result += (inner as { Value?: string }).Value ?? "";
        } else {
          result += "<dynamic>";
        }
      }
    } else {
      result += "<dynamic>";
    }
  }
  return result;
}

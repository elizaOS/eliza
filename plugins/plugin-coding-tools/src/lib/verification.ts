/** SHELL owns interpretation of its command and observed output. The planner
 * consumes the resulting receipt without parsing shell syntax or test logs. */
import type { ActionResult } from "@elizaos/core";

type CodingVerificationKind =
  | "compile"
  | "test"
  | "typecheck"
  | "lint"
  | "build"
  | "other_verification";

export function shellVerificationReceipt(args: {
  command: string;
  exitCode: number;
  output: string;
  signal?: string | null;
}): ActionResult["verification"] {
  const kind = codingVerificationKind(args.command);
  if (
    !kind ||
    args.signal ||
    !Number.isInteger(args.exitCode) ||
    args.exitCode < 0 ||
    args.exitCode === 126 ||
    args.exitCode === 127
  )
    return undefined;
  const status =
    args.exitCode !== 0
      ? "failed"
      : kind === "test" && verificationRanNoTests(args.output)
        ? "no_tests"
        : "passed";
  const segment =
    splitSafeShellVerificationChain(args.command)?.[0] ?? args.command;
  const family = stripShellVerificationPrefix(segment)
    .trim()
    .split(/\s+/u)
    .slice(0, 2)
    .join(" ")
    .toLowerCase();
  return { kind, status, family, exitCode: args.exitCode };
}

function verificationRanNoTests(output: string): boolean {
  if (!/\[no tests to run\]/i.test(output)) return false;
  const packageResults = output
    .split(/\r?\n/u)
    .filter((line) => /^ok\s+\S+\s+\S+/u.test(line));
  return (
    packageResults.length > 0 &&
    packageResults.every((line) => /\[no tests to run\]/i.test(line))
  );
}

const CODING_VERIFICATION_PATTERNS = [
  /^bun\s+(?:run\s+)?(?:(?:--cwd|-C)\s+\S+\s+)?(?:test|verify|check|lint|typecheck|build)(?:\s|$)/i,
  /^npm\s+(?:test|(?:run|run-script)\s+(?:test|verify|check|lint|typecheck|build))(?:\s|$)/i,
  /^(?:pnpm|yarn)\s+(?:run\s+)?(?:test|verify|check|lint|typecheck|build)(?:\s|$)/i,
  /^(?:npm|pnpm)\s+exec\s+(?:vitest|jest|eslint|biome|tsc)(?:\s|$)/i,
  /^(?:npx|bunx)\s+(?:--yes\s+)?(?:vitest|jest|eslint|biome|tsc)(?:\s|$)/i,
  /^deno\s+(?:test|check|task\s+(?:test|verify|check|lint|typecheck|build))(?:\s|$)/i,
  /^(?:vitest|jest|pytest|rspec|phpunit|mocha|ava)(?:\s|$)/i,
  /^(?:uv|poetry)\s+run\s+(?:(?:python\d*\s+-m\s+)?pytest|ruff|mypy)(?:\s|$)/i,
  /^bundle\s+exec\s+rspec(?:\s|$)/i,
  /^go\s+(?:test|vet|build)(?:\s|$)/i,
  /^cargo\s+(?:test|check|clippy|build|nextest\s+run)(?:\s|$)/i,
  /^(?:dotnet\s+test|(?:mvn|\.\/mvnw)\s+(?:test|verify)|gradle\w*\s+(?:test|check|build)|(?:\.\/)?gradlew\s+(?:(?:\S*:)?(?:test|check|build)\w*))(?:\s|$)/i,
  /^(?:swift|mix)\s+test(?:\s|$)/i,
  /^tox(?:\s|$)/i,
  /^(?:make|just)(?:\s+[^\s;&|]+)*\s+(?:test|verify|check|lint|typecheck|build)(?:\s|$)/i,
  /^(?:tsc|eslint|biome)(?:\s|$)/i,
  /^(?:python\d*\s+-m\s+(?:pytest|unittest|compileall|py_compile)|ruby\s+-c|bash\s+-n|node\s+--check)(?:\s|$)/i,
] as const;

function codingVerificationKind(
  command: string,
): CodingVerificationKind | undefined {
  const segments = splitSafeShellVerificationChain(command);
  if (!segments) return undefined;
  for (const segment of segments) {
    const normalized = stripShellVerificationPrefix(segment);
    if (
      isNoopShellVerificationCommand(normalized) ||
      !CODING_VERIFICATION_PATTERNS.some((pattern) => pattern.test(normalized))
    ) {
      continue;
    }
    if (
      /\b(?:test|vitest|jest|pytest|rspec|phpunit|mocha|ava|unittest|nextest)\b/i.test(
        normalized,
      )
    ) {
      return "test";
    }
    if (
      /\b(?:typecheck|tsc|mypy|deno\s+check|cargo\s+check)\b/i.test(normalized)
    ) {
      return "typecheck";
    }
    if (/\b(?:lint|eslint|biome|ruff|clippy|go\s+vet)\b/i.test(normalized)) {
      return "lint";
    }
    if (/\bbuild\b/i.test(normalized)) return "build";
    if (
      /\b(?:compileall|py_compile)\b|\b(?:ruby|bash)\s+-[cn]\b|\bnode\s+--check\b/i.test(
        normalized,
      )
    ) {
      return "compile";
    }
    return "other_verification";
  }
  return undefined;
}

function isNoopShellVerificationCommand(command: string): boolean {
  return (
    /(?:^|\s)["']?(?:--help|-h|--version|--list|--listTests|--collect-only|--co|--dry-run|--no-run|--showConfig)["']?(?:=|\s|$)/i.test(
      command,
    ) || /(?:^|\s)["']?-V["']?(?:\s|$)/.test(command)
  );
}

/**
 * Parses the only untyped compound command whose aggregate zero exit status
 * proves every verifier ran successfully: a foreground `&&` chain. Shell
 * redirections containing `&` are retained inside their command. Every other
 * unquoted control operator is rejected because it can hide, defer, or replace
 * the verifier exit status.
 */
function splitSafeShellVerificationChain(command: string): string[] | null {
  const segments: string[] = [];
  let start = 0;
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = 0; index < command.length; index++) {
    const character = command[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = quote === character ? undefined : (quote ?? character);
      continue;
    }
    if (quote) continue;
    if (character === ";" || character === "|" || character === "\n") {
      return null;
    }
    if (character === "&") {
      if (command[index - 1] === ">" || command[index + 1] === ">") {
        continue;
      }
      if (command[index + 1] !== "&") return null;
      const segment = command.slice(start, index).trim();
      if (!segment) return null;
      segments.push(segment);
      index++;
      start = index + 1;
    }
  }
  const tail = command.slice(start).trim();
  if (!tail) return null;
  segments.push(tail);
  return segments;
}

function stripShellVerificationPrefix(segment: string): string {
  let command = segment.trim();
  if (/^env(?:\s|$)/i.test(command)) {
    command = command.replace(/^env\s+/i, "");
  }
  while (/^[A-Za-z_][A-Za-z0-9_]*=\S+\s+/.test(command)) {
    command = command.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S+\s+/, "");
  }
  return command;
}

/**
 * Guards tracked end-to-end harnesses against port-allocation races without a
 * historical count or exception baseline. TypeScript syntax inspection keeps
 * comments and string fixtures out of the result while recognizing formatted
 * listen calls; shell tokenization covers Docker publications without matching
 * quoted examples. Consumers must bind port zero and retain the socket, or use
 * the repository port-file handshake when another process owns the listener.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const SCRIPT_EXTENSION = /\.(?:mjs|cjs|js|jsx|mts|cts|ts|tsx|sh)$/;
const TOCTOU_ALLOCATOR = /\ballocateFreePorts\b/;
const POSSIBLE_LISTEN_CALL = /\.listen\b|\[\s*["']listen["']\s*\]/;
const LITERAL_DOCKER_PORT_SPEC =
  /^(?:(?:\[[0-9a-f:]+\]|(?:\d{1,3}\.){3}\d{1,3}):)?((?!0+$)\d{1,5})(?:-\d{1,5})?:/i;

function isE2eScript(file: string): boolean {
  return (
    SCRIPT_EXTENSION.test(file) &&
    file
      .toLowerCase()
      .split("/")
      .some((segment) => segment.includes("e2e"))
  );
}

function trackedE2eScripts(): string[] {
  return execFileSync("git", ["ls-files", "-z"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter((file) => file && isE2eScript(file));
}

const TRACKED_E2E_SCRIPTS = trackedE2eScripts();

function executableLines(
  file: string,
  content: string,
): Array<{ line: string; lineNumber: number }> {
  return content
    .split("\n")
    .map((line, index) => ({ line, lineNumber: index + 1 }))
    .filter(({ line }) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      return file.endsWith(".sh") ? !trimmed.startsWith("#") : true;
    });
}

function literalPort(node: ts.Expression | undefined): number | undefined {
  if (!node) return undefined;
  if (ts.isParenthesizedExpression(node)) return literalPort(node.expression);
  if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.PlusToken
  ) {
    return literalPort(node.operand);
  }
  if (ts.isNumericLiteral(node)) return Number(node.text.replaceAll("_", ""));
  if (ts.isStringLiteralLike(node) && /^\d+$/.test(node.text)) {
    return Number(node.text);
  }
  if (ts.isObjectLiteralExpression(node)) {
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const name = property.name;
      if (
        (ts.isIdentifier(name) || ts.isStringLiteral(name)) &&
        name.text === "port"
      ) {
        return literalPort(property.initializer);
      }
    }
  }
  return undefined;
}

function calledMethodName(
  expression: ts.LeftHandSideExpression,
): string | undefined {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (
    ts.isElementAccessExpression(expression) &&
    ts.isStringLiteralLike(expression.argumentExpression)
  ) {
    return expression.argumentExpression.text;
  }
  return undefined;
}

function typescriptOffenses(
  file: string,
  content: string,
): Array<{ lineNumber: number; reason: string }> {
  const source = ts.createSourceFile(
    file,
    content,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const offenses: Array<{ lineNumber: number; reason: string }> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === "allocateFreePorts") {
      const { line } = source.getLineAndCharacterOfPosition(
        node.getStart(source),
      );
      offenses.push({ lineNumber: line + 1, reason: "allocateFreePorts" });
    }
    if (
      ts.isCallExpression(node) &&
      calledMethodName(node.expression) === "listen"
    ) {
      const port = literalPort(node.arguments[0]);
      if (port !== undefined && Number.isInteger(port) && port !== 0) {
        const { line } = source.getLineAndCharacterOfPosition(
          node.getStart(source),
        );
        offenses.push({
          lineNumber: line + 1,
          reason: `literal listen port ${port}`,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return offenses;
}

function shellLogicalLines(content: string): string[] {
  return content.replaceAll(/\\\r?\n/g, " ").split("\n");
}

function shellCommands(line: string): string[][] {
  const commands: string[][] = [[]];
  let word = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (const character of line) {
    if (escaped) {
      word += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else word += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "#" && word.length === 0) break;
    if (/\s/.test(character) || ";|&()".includes(character)) {
      if (word) commands.at(-1)?.push(word);
      word = "";
      if (";|&()".includes(character) && commands.at(-1)?.length) {
        commands.push([]);
      }
      continue;
    }
    word += character;
  }
  if (word) commands.at(-1)?.push(word);
  return commands.filter((command) => command.length > 0);
}

function literalDockerHostPort(line: string): boolean {
  for (const words of shellCommands(line)) {
    const dockerIndex = words.findIndex(
      (word, index) =>
        (word === "docker" || word.endsWith("/docker")) &&
        (index === 0 ||
          (index === 1 && ["command", "env", "sudo"].includes(words[0]))),
    );
    if (dockerIndex < 0) continue;
    const dockerWords = words.slice(dockerIndex + 1);
    for (let index = 0; index < dockerWords.length; index += 1) {
      const word = dockerWords[index];
      let specification: string | undefined;
      if (word === "-p" || word === "--publish") {
        specification = dockerWords[index + 1];
      } else if (word.startsWith("-p=")) {
        specification = word.slice(3);
      } else if (word.startsWith("-p")) {
        specification = word.slice(2);
      } else if (word.startsWith("--publish=")) {
        specification = word.slice("--publish=".length);
      }
      if (specification && LITERAL_DOCKER_PORT_SPEC.test(specification)) {
        return true;
      }
    }
  }
  return false;
}

describe("e2e port safety", () => {
  it("covers each tracked e2e script family", () => {
    const files = TRACKED_E2E_SCRIPTS;
    for (const exemplar of [
      "packages/ui/src/cloud/organization/__e2e__/run-credentials-e2e.mjs",
      "packages/core/e2e/setup/global-setup.ts",
      "packages/cloud/shared/scripts/verify-e2e-container-db.sh",
      ".github/scripts/android-device-e2e/pr-device-smoke.sh",
    ]) {
      expect(files).toContain(exemplar);
    }
  });

  it("rejects probe-then-release port allocation", () => {
    const offenders = TRACKED_E2E_SCRIPTS.filter((file) => {
      const content = readFileSync(path.join(REPO_ROOT, file), "utf8");
      if (file.endsWith(".sh")) {
        return executableLines(file, content).some(({ line }) =>
          TOCTOU_ALLOCATOR.test(line),
        );
      }
      if (!TOCTOU_ALLOCATOR.test(content)) return false;
      return typescriptOffenses(file, content).some(
        ({ reason }) => reason === "allocateFreePorts",
      );
    });
    expect(
      offenders,
      "allocateFreePorts releases its probe socket before the consumer binds; " +
        "bind port 0 in the consumer or use packages/scripts/e2e-ports.mjs",
    ).toEqual([]);
  });

  it("rejects literal host listen and Docker-publish ports", () => {
    const offenders: string[] = [];
    for (const file of TRACKED_E2E_SCRIPTS) {
      const content = readFileSync(path.join(REPO_ROOT, file), "utf8");
      if (file.endsWith(".sh")) {
        executableLines(file, shellLogicalLines(content).join("\n")).forEach(
          ({ line, lineNumber }) => {
            if (literalDockerHostPort(line)) {
              offenders.push(`${file}:${lineNumber}: ${line.trim()}`);
            }
          },
        );
        continue;
      }
      if (!POSSIBLE_LISTEN_CALL.test(content)) continue;
      typescriptOffenses(file, content)
        .filter(({ reason }) => reason.startsWith("literal listen port"))
        .forEach(({ lineNumber, reason }) => {
          offenders.push(`${file}:${lineNumber}: ${reason}`);
        });
    }
    expect(
      offenders,
      "literal host ports collide under CI fan-out; bind port 0 and retain the " +
        "socket, or advertise the bound port through the port-file handshake",
    ).toEqual([]);
  });

  it("recognizes unsafe forms while accepting retained dynamic binds", () => {
    const listenPorts = (source: string) =>
      typescriptOffenses("fixture.ts", source).filter(({ reason }) =>
        reason.startsWith("literal listen port"),
      );
    for (const source of [
      "server.listen(36414, host)",
      "server.listen(80, host)",
      "server.listen('443', host)",
      "server.listen('00080', host)",
      "server.listen(8_080, host)",
      "server.listen(0x1f90, host)",
      "server.listen({ port: 8080, host })",
      "server.listen(\n /* retained formatting */ 8080, host)",
      'server["listen"](+8080, host)',
    ]) {
      expect(listenPorts(source), source).toHaveLength(1);
    }
    for (const source of [
      "server.listen(0, host)",
      "server.listen('00000', host)",
      "server.listen(boundPort, host)",
      "server.listen({ port: boundPort, host })",
      'const example = "server.listen(8080, host)"',
      "// server.listen(8080, host)",
    ]) {
      expect(listenPorts(source), source).toHaveLength(0);
    }
    expect(literalDockerHostPort("docker run --publish 8080:80 image")).toBe(
      true,
    );
    expect(literalDockerHostPort("docker run -p 80:8080 image")).toBe(true);
    expect(literalDockerHostPort("docker run -p 00080:8080 image")).toBe(true);
    expect(
      literalDockerHostPort('docker run --publish "127.0.0.1:443:8443" image'),
    ).toBe(true);
    expect(
      literalDockerHostPort('docker run --publish "[::1]:443:8443" image'),
    ).toBe(true);
    expect(literalDockerHostPort("docker run -p 5432 image")).toBe(false);
    expect(literalDockerHostPort('docker run -p "$HOST_PORT:5432" image')).toBe(
      false,
    );
    expect(literalDockerHostPort("docker run -p8080:80 image")).toBe(true);
    expect(
      literalDockerHostPort(
        shellLogicalLines("docker run -p \\\n8080:80 image").join("\n"),
      ),
    ).toBe(true);
    expect(literalDockerHostPort('echo "docker run -p 8080:80"')).toBe(false);
    expect(literalDockerHostPort("echo docker -p 8080:80")).toBe(false);
    expect(literalDockerHostPort("echo docker; helper -p 8080:80")).toBe(false);
    expect(literalDockerHostPort("# docker run -p 8080:80 image")).toBe(false);
  });
});

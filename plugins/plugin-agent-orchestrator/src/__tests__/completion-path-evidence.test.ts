/** Exercises ACP write-path capture and completion rendering with real files and temporary Git repositories. */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AcpService } from "../services/acp-service.js";
import { renderChangeSetBody } from "../services/completion-evidence.js";
import {
  captureChangeSet,
  subtractChangeSetBaseline,
  type WorkspaceChangeSet,
} from "../services/workspace-diff.js";

describe("complete path evidence", () => {
  let dir: string;
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "completion-path-evidence-"));
    git("init", "-q");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    writeFileSync(join(dir, ".gitignore"), "artifacts/\n");
    git("add", ".gitignore");
    git("commit", "-q", "-m", "baseline");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("renders every tool write after the first 500, with exact path bytes", async () => {
    rmSync(join(dir, ".git"), { recursive: true, force: true });
    const service = new AcpService(
      new AgentRuntime({ character: { name: "Path evidence" } }),
    );
    mkdirSync(join(dir, "artifacts"));
    const names = [
      ...Array.from({ length: 500 }, (_, index) => `artifact-${index}.txt`),
      " spaced.txt ",
      "tab\tname.txt",
      "line\nname.txt",
      "snow☃.txt",
      " ",
    ].map((name) => `artifacts/${name}`);
    for (const [index, path] of names.entries()) {
      writeFileSync(join(dir, path), `CONTENT_${index}_END\n`);
      service["handleAcpEvent"](
        {
          method: "session/update",
          params: {
            sessionId: "path-session",
            update: {
              sessionUpdate: "tool_call",
              toolCallId: `write-${index}`,
              kind: "write",
              status: "completed",
              ...(index % 2 === 0
                ? { rawInput: { path } }
                : { locations: [{ path }] }),
            },
          },
        },
        "path-session",
        "",
        Date.now(),
        false,
        new Set(),
      );
    }
    const changed = await captureChangeSet(
      dir,
      undefined,
      service.getChangedPaths("path-session"),
    );
    if (!changed) throw new Error("Expected complete tool-write evidence");
    expect(changed.changedFiles).toEqual(names);
    const rendered = renderChangeSetBody(changed);
    for (const [index, path] of names.entries()) {
      expect(rendered).toContain(path);
      expect(rendered).toContain(`+CONTENT_${index}_END`);
    }
  }, 60_000);

  it.each([true, false])(
    "subtracts exact special filenames with Git quotePath=%s and persisted legacy captures",
    async (quotePath) => {
      git("config", "core.quotePath", String(quotePath));
      const names = [
        " spaced.txt ",
        "spaced.txt",
        "tab\tname.txt",
        "line\nname.txt",
        "snow☃.txt",
        'quote"name.txt',
        "binary.dat",
        "deleted.txt",
      ];
      for (const [index, name] of names.entries())
        writeFileSync(
          join(dir, name),
          `BEFORE_${index}\n${index === 1 ? "stable rename context\n".repeat(20) : ""}`,
        );
      git("add", ".");
      git("commit", "-q", "-m", "files");
      for (const [index, name] of names.entries())
        writeFileSync(
          join(dir, name),
          `CHANGED_${index}\n${index === 1 ? "stable rename context\n".repeat(20) : ""}`,
        );
      writeFileSync(join(dir, "binary.dat"), Buffer.from([0, 1, 2, 3]));
      rmSync(join(dir, "deleted.txt"));
      git("mv", "spaced.txt", "renamed\t☃.txt");
      const captured = await captureChangeSet(dir);
      if (!captured) throw new Error("Expected captured Git evidence");
      const legacy: WorkspaceChangeSet = {
        ...captured,
        fileDiffs: undefined,
        diff: git("diff", "HEAD"),
      };
      expect(legacy.diff).toContain("rename from spaced.txt");
      for (const source of [captured, legacy]) {
        for (const removed of source.changedFiles) {
          const remaining = source.changedFiles.filter(
            (path) => path !== removed,
          );
          const result = subtractChangeSetBaseline(source, [removed]);
          expect(result.changedFiles).toEqual(remaining);
          const onlyRemoved = subtractChangeSetBaseline(source, remaining);
          expect(onlyRemoved.changedFiles).toEqual([removed]);
          expect(result.diff).not.toContain(onlyRemoved.diff.trim());
          const rendered = renderChangeSetBody(result);
          for (const path of remaining) {
            expect(rendered).toContain(path);
            if (path === "binary.dat")
              expect(result.diff).toContain("Binary files");
            else if (path === "deleted.txt")
              expect(result.diff).toContain("-BEFORE_7");
            else {
              const index = path === "renamed\t☃.txt" ? 1 : names.indexOf(path);
              expect(result.diff).toContain(`+CHANGED_${index}`);
            }
          }
          expect(subtractChangeSetBaseline(result, remaining).diff).toBe("");
        }
      }
    },
    15_000,
  );

  it("keeps neighboring whitespace names distinct and rejects unowned legacy or inconsistent persisted patches", async () => {
    for (const name of [" x ", "x"])
      writeFileSync(join(dir, name), `before ${name}\n`);
    git("add", ".");
    git("commit", "-q", "-m", "files");
    writeFileSync(join(dir, " x "), "SPACE_PATH_MARKER\n");
    writeFileSync(join(dir, "x"), "PLAIN_PATH_MARKER\n");
    const captured = await captureChangeSet(dir);
    if (!captured) throw new Error("Expected captured evidence");
    const result = subtractChangeSetBaseline(captured, [" x "]);
    expect(result.changedFiles).toEqual(["x"]);
    expect(result.diff).toContain("+PLAIN_PATH_MARKER");
    expect(result.diff).not.toContain("SPACE_PATH_MARKER");
    for (const broken of [
      { ...captured, fileDiffs: undefined, diff: "unattributed patch output" },
      { ...captured, diff: "mismatched persisted patch" },
    ]) {
      expect(() => subtractChangeSetBaseline(broken, [" x "])).toThrow(
        expect.objectContaining({
          code: "WORKSPACE_CHANGESET_PATCH_OWNERSHIP_INVALID",
        }),
      );
    }
  });
});

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  changeDirectory,
  editFile,
  executeShell,
  git,
  listFiles,
  readFile,
  searchFiles,
  writeFile,
} from "../actions";
import { CoderService } from "../services/coderService";

type RuntimeStub = {
  getService: <T>(type: string) => T | null;
};

function mkRuntime(service: CoderService): RuntimeStub {
  return {
    getService: <T>(type: string): T | null => {
      if (type === "coder") return service as T;
      return null;
    },
  };
}

function mkMemory(text: string): {
  content: { text: string };
  roomId: string;
  agentId: string;
} {
  return {
    content: { text },
    roomId: "room-1",
    agentId: "agent-1",
  };
}

describe("coder actions (behavior)", () => {
  let tmp: string;
  let svc: CoderService;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "eliza-coder-"));
    process.env.CODER_ENABLED = "true";
    process.env.CODER_ALLOWED_DIRECTORY = tmp;
    process.env.CODER_TIMEOUT = "30000";

    // Fresh service so config re-loads.
    svc = new CoderService({} as never);
    await svc.stop();
  });

  it("WRITE_FILE then READ_FILE", async () => {
    const runtime = mkRuntime(svc) as never;
    const msg = mkMemory('write "a.txt"');
    const w = await writeFile.handler(runtime, msg as never, undefined, {
      filepath: "a.txt",
      content: "hello",
    });
    expect(w.success).toBe(true);

    const r = await readFile.handler(
      runtime,
      mkMemory('read "a.txt"') as never,
      undefined,
      {
        filepath: "a.txt",
      },
    );
    expect(r.success).toBe(true);
    expect(r.text).toContain("hello");
  });

  it("EDIT_FILE replaces substring", async () => {
    const runtime = mkRuntime(svc) as never;
    await writeFile.handler(runtime, mkMemory("write") as never, undefined, {
      filepath: "b.txt",
      content: "abc",
    });
    const e = await editFile.handler(
      runtime,
      mkMemory("edit") as never,
      undefined,
      {
        filepath: "b.txt",
        old_str: "b",
        new_str: "B",
      },
    );
    expect(e.success).toBe(true);
    const r = await readFile.handler(
      runtime,
      mkMemory("read") as never,
      undefined,
      {
        filepath: "b.txt",
      },
    );
    expect(r.text).toContain("aBc");
  });

  it("LIST_FILES shows created file", async () => {
    const runtime = mkRuntime(svc) as never;
    await writeFile.handler(runtime, mkMemory("write") as never, undefined, {
      filepath: "c.txt",
      content: "x",
    });
    const ls = await listFiles.handler(
      runtime,
      mkMemory("list") as never,
      undefined,
      {
        path: ".",
      },
    );
    expect(ls.success).toBe(true);
    expect(ls.text).toContain("c.txt");
  });

  it("SEARCH_FILES finds match", async () => {
    const runtime = mkRuntime(svc) as never;
    await writeFile.handler(runtime, mkMemory("write") as never, undefined, {
      filepath: "d.txt",
      content: "needle here",
    });
    const s = await searchFiles.handler(
      runtime,
      mkMemory("search") as never,
      undefined,
      {
        pattern: "needle",
        path: ".",
        maxMatches: 50,
      },
    );
    expect(s.success).toBe(true);
    expect(s.text).toContain("d.txt");
  });

  it("CHANGE_DIRECTORY cannot escape allowed directory", async () => {
    const runtime = mkRuntime(svc) as never;
    const cd = await changeDirectory.handler(
      runtime,
      mkMemory("cd") as never,
      undefined,
      {
        path: "..",
      },
    );
    expect(cd.success).toBe(false);
  });

  it("EXECUTE_SHELL runs in restricted cwd", async () => {
    const runtime = mkRuntime(svc) as never;
    const res = await executeShell.handler(
      runtime,
      mkMemory("shell") as never,
      undefined,
      {
        command: "pwd",
      },
    );
    expect(res.success).toBe(true);
    expect(res.text).toContain(tmp);
  });

  it("GIT fails gracefully when not a repo", async () => {
    const runtime = mkRuntime(svc) as never;
    const res = await git.handler(
      runtime,
      mkMemory("git") as never,
      undefined,
      {
        args: "status",
      },
    );
    expect(res.success).toBe(false);
  });
});

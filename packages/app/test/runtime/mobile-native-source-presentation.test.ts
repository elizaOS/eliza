import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";

const capture = vi.hoisted(() => ({
  reader: undefined as
    | undefined
    | ((request: Record<string, unknown>) => Promise<unknown>),
  response: {} as Record<string, unknown>,
  request: undefined as unknown,
}));
vi.mock("@elizaos/plugin-workflow/services/hosted-native-source", () => ({
  configureHostedNativeSourceReader: (reader: typeof capture.reader) => {
    capture.reader = reader;
  },
}));
vi.mock("@elizaos/plugin-workflow/services/workflow-process-host", () => ({
  WORKFLOW_BUN_FLAGS: [],
  configureWorkflowProcessHost: () => {},
}));
vi.mock("@elizaos/plugin-native-inference/bionic-host-request", () => ({
  requestBionicHost: async (socket: string, request: unknown) => {
    expect(socket).toBe("native-source-fixture");
    capture.request = request;
    return capture.response;
  },
}));

import { installMobileWorkflowProcessHost } from "../../src/runtime/install-mobile-workflow-process-host";

test("installed native source callback reuses local display formatter without changing all-day dates or making another request", async () => {
  const temporary = realpathSync(
      mkdtempSync(join(tmpdir(), "native-source-presentation-")),
    ),
    root = join(temporary, "artifact"),
    compiler = join(root, "compiler/node_modules/typescript/lib"),
    state = join(temporary, "state"),
    library = join(temporary, "lib");
  try {
    for (const path of [compiler, state, library])
      mkdirSync(path, { recursive: true });
    const digest = (text: string) =>
      createHash("sha256").update(text).digest("hex");
    const name = "compiler/node_modules/typescript/lib/typescript.js",
      module = "export {};";
    writeFileSync(join(root, name), module);
    const manifest = JSON.stringify({
      version: 1,
      compiler: {
        version: 1,
        compilerModule: "node_modules/typescript/lib/typescript.js",
      },
      files: { [name]: digest(module) },
    });
    writeFileSync(join(root, "manifest.json"), manifest);
    writeFileSync(
      join(root, "files.sha256"),
      `${digest(manifest)}\tmanifest.json\n${digest(module)}\t${name}\n`,
    );
    const loader = join(temporary, "loader"),
      bun = join(temporary, "bun");
    writeFileSync(loader, "fixture-loader");
    writeFileSync(bun, "fixture-bun");
    installMobileWorkflowProcessHost({
      ELIZA_PLATFORM: "android",
      ELIZA_MOBILE_WORKFLOWS: "1",
      ELIZA_SMTHRS_RUNTIME_DIR: root,
      ELIZA_STATE_DIR: state,
      LD_LIBRARY_PATH: library,
      LD_PATH: loader,
      BUN_PATH: bun,
      ELIZA_BIONIC_HOST_DELEGATED: "1",
      ELIZA_BIONIC_INFERENCE_SOCK: "native-source-fixture",
    });
    capture.response = {
      ok: true,
      result: {
        timeZone: "America/Los_Angeles",
        events: [
          {
            start: "2026-11-01T00:00:00.000Z",
            end: "2026-11-02T00:00:00.000Z",
            allDay: true,
          },
          {
            start: "2026-11-01T08:30:00.000Z",
            end: "2026-11-01T09:30:00.000Z",
            allDay: false,
          },
        ],
        reminders: [{ dueAt: "2026-10-08T15:43:19.576Z" }],
      },
    };
    const request = {
      action: "read",
      sourceId: "reviewed",
      occurrence: "2026-10-08T15:41:19.576Z",
    };
    const result = (await capture.reader!(request)) as any;
    expect(capture.request).toEqual({ op: "nativeSourceRead", request });
    expect(result.events[0].startDisplay).toBe("Nov 1, 2026");
    expect(result.events[0].endDateExclusive).toBe("2026-11-02");
    expect(result.events[1].startDisplay).toContain("1:30 AM PDT");
    expect(result.events[1].endDisplay).toContain("1:30 AM PST");
    expect(result.reminders[0].dueAtDisplay).toBe("Oct 8, 2026, 8:43 AM PDT");
    expect(result.reminders[0].dueAt).toBe("2026-10-08T15:43:19.576Z");
    capture.response = {
      ok: true,
      result: {
        timeZone: "Pacific/Invalid",
        events: [],
        reminders: [{ dueAt: "2026-10-08T15:43:19.576Z" }],
      },
    };
    await expect(capture.reader!(request)).rejects.toThrow();
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

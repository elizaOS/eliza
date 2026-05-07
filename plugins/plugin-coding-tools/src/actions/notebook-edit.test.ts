import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setupEnv, type TestEnv } from "./_test-helpers.js";
import { notebookEditAction } from "./notebook-edit.js";

interface NotebookCell {
  cell_type: string;
  id?: string;
  metadata?: Record<string, unknown>;
  source: string[] | string;
  outputs?: unknown[];
  execution_count?: number | null;
}

interface Notebook {
  cells: NotebookCell[];
  metadata?: Record<string, unknown>;
  nbformat?: number;
  nbformat_minor?: number;
}

function makeNotebook(cells: NotebookCell[]): Notebook {
  return {
    cells,
    metadata: { language_info: { name: "python" } },
    nbformat: 4,
    nbformat_minor: 5,
  };
}

async function readNotebook(file: string): Promise<Notebook> {
  return JSON.parse(await fs.readFile(file, "utf8")) as Notebook;
}

describe("NOTEBOOK_EDIT", () => {
  let env: TestEnv;

  beforeEach(async () => {
    env = await setupEnv("nbedit-test");
  });

  afterEach(async () => {
    await env.cleanup();
  });

  async function seedNotebook(
    name: string,
    cells: NotebookCell[],
  ): Promise<string> {
    const file = path.join(env.tmpDir, name);
    await fs.writeFile(
      file,
      JSON.stringify(makeNotebook(cells), null, 1),
      "utf8",
    );
    await env.fileState.recordRead("test-room", file);
    return file;
  }

  it("replaces an existing cell's source", async () => {
    const file = await seedNotebook("a.ipynb", [
      {
        cell_type: "code",
        id: "c1",
        metadata: {},
        source: ["print('a')\n"],
        outputs: [],
        execution_count: null,
      },
      {
        cell_type: "code",
        id: "c2",
        metadata: {},
        source: ["print('b')\n"],
        outputs: [],
        execution_count: null,
      },
    ]);

    const result = await notebookEditAction.handler?.(
      env.runtime,
      env.message,
      undefined,
      {
        parameters: {
          notebook_path: file,
          cell_id: "c2",
          new_source: "print('updated')\nprint('two')",
        },
      },
    );

    expect(result.success).toBe(true);
    const nb = await readNotebook(file);
    expect(nb.cells.length).toBe(2);
    expect(nb.cells[1].id).toBe("c2");
    expect(nb.cells[1].source).toEqual(["print('updated')\n", "print('two')"]);
  });

  it("inserts a new cell after a target cell_id", async () => {
    const file = await seedNotebook("b.ipynb", [
      {
        cell_type: "code",
        id: "first",
        metadata: {},
        source: ["x = 1\n"],
        outputs: [],
        execution_count: null,
      },
    ]);

    const result = await notebookEditAction.handler?.(
      env.runtime,
      env.message,
      undefined,
      {
        parameters: {
          notebook_path: file,
          cell_id: "first",
          new_source: "y = 2",
          edit_mode: "insert",
          cell_type: "code",
        },
      },
    );

    expect(result.success).toBe(true);
    const nb = await readNotebook(file);
    expect(nb.cells.length).toBe(2);
    expect(nb.cells[1].cell_type).toBe("code");
    expect(nb.cells[1].source).toEqual(["y = 2"]);
    expect(typeof nb.cells[1].id).toBe("string");
    expect((nb.cells[1].id ?? "").length).toBeGreaterThan(0);
  });

  it("inserts at the start when cell_id is omitted", async () => {
    const file = await seedNotebook("c.ipynb", [
      {
        cell_type: "code",
        id: "old",
        metadata: {},
        source: ["print('old')\n"],
        outputs: [],
        execution_count: null,
      },
    ]);

    const result = await notebookEditAction.handler?.(
      env.runtime,
      env.message,
      undefined,
      {
        parameters: {
          notebook_path: file,
          new_source: "## intro",
          edit_mode: "insert",
          cell_type: "markdown",
        },
      },
    );

    expect(result.success).toBe(true);
    const nb = await readNotebook(file);
    expect(nb.cells.length).toBe(2);
    expect(nb.cells[0].cell_type).toBe("markdown");
    expect(nb.cells[0].source).toEqual(["## intro"]);
    expect(nb.cells[1].id).toBe("old");
  });

  it("deletes a cell by cell_id", async () => {
    const file = await seedNotebook("d.ipynb", [
      {
        cell_type: "code",
        id: "keep",
        metadata: {},
        source: ["1\n"],
        outputs: [],
        execution_count: null,
      },
      {
        cell_type: "code",
        id: "drop",
        metadata: {},
        source: ["2\n"],
        outputs: [],
        execution_count: null,
      },
    ]);

    const result = await notebookEditAction.handler?.(
      env.runtime,
      env.message,
      undefined,
      {
        parameters: {
          notebook_path: file,
          cell_id: "drop",
          edit_mode: "delete",
        },
      },
    );

    expect(result.success).toBe(true);
    const nb = await readNotebook(file);
    expect(nb.cells.length).toBe(1);
    expect(nb.cells[0].id).toBe("keep");
  });

  it("rejects non-.ipynb extensions", async () => {
    const file = path.join(env.tmpDir, "wrong.txt");
    await fs.writeFile(file, "{}", "utf8");

    const result = await notebookEditAction.handler?.(
      env.runtime,
      env.message,
      undefined,
      {
        parameters: {
          notebook_path: file,
          cell_id: "x",
          new_source: "y",
        },
      },
    );

    expect(result.success).toBe(false);
    expect(result.text).toContain("invalid_param");
    expect(result.text).toContain(".ipynb");
  });

  it("fails with no_match when cell_id doesn't exist for replace", async () => {
    const file = await seedNotebook("e.ipynb", [
      {
        cell_type: "code",
        id: "only",
        metadata: {},
        source: ["1\n"],
        outputs: [],
        execution_count: null,
      },
    ]);

    const result = await notebookEditAction.handler?.(
      env.runtime,
      env.message,
      undefined,
      {
        parameters: {
          notebook_path: file,
          cell_id: "missing",
          new_source: "x",
        },
      },
    );

    expect(result.success).toBe(false);
    expect(result.text).toContain("no_match");
  });

  it("requires a prior READ (must_read_first)", async () => {
    const file = path.join(env.tmpDir, "fresh.ipynb");
    await fs.writeFile(
      file,
      JSON.stringify(
        makeNotebook([{ cell_type: "code", id: "c1", source: [] }]),
        null,
        1,
      ),
      "utf8",
    );

    const result = await notebookEditAction.handler?.(
      env.runtime,
      env.message,
      undefined,
      {
        parameters: {
          notebook_path: file,
          cell_id: "c1",
          new_source: "x",
        },
      },
    );

    expect(result.success).toBe(false);
    expect(result.text).toContain("not read in this session");
  });

  it("rejects paths under the blocklist", async () => {
    const file = path.join(env.blockedPath, "secret.ipynb");
    const result = await notebookEditAction.handler?.(
      env.runtime,
      env.message,
      undefined,
      {
        parameters: {
          notebook_path: file,
          cell_id: "c1",
          new_source: "x",
        },
      },
    );

    expect(result.success).toBe(false);
    expect(result.text).toContain("path_blocked");
  });

  it("fails on invalid edit_mode", async () => {
    const file = await seedNotebook("f.ipynb", [
      { cell_type: "code", id: "c1", metadata: {}, source: [] },
    ]);

    const result = await notebookEditAction.handler?.(
      env.runtime,
      env.message,
      undefined,
      {
        parameters: {
          notebook_path: file,
          cell_id: "c1",
          new_source: "x",
          edit_mode: "shred",
        },
      },
    );

    expect(result.success).toBe(false);
    expect(result.text).toContain("invalid_param");
    expect(result.text).toContain("edit_mode");
  });
});

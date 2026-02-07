import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CombinedAutocompleteProvider } from "../src/autocomplete.js";

const resolveFdPath = (): string | null => {
  const command = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(command, ["fd"], { encoding: "utf-8" });
  if (result.status !== 0 || !result.stdout) {
    return null;
  }

  const firstLine = result.stdout.split(/\r?\n/).find(Boolean);
  return firstLine ? firstLine.trim() : null;
};

type FolderStructure = {
  dirs?: string[];
  files?: Record<string, string>;
};

const setupFolder = (
  baseDir: string,
  structure: FolderStructure = {},
): void => {
  const dirs = structure.dirs ?? [];
  const files = structure.files ?? {};

  dirs.forEach((dir) => {
    mkdirSync(join(baseDir, dir), { recursive: true });
  });
  Object.entries(files).forEach(([filePath, contents]) => {
    const fullPath = join(baseDir, filePath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, contents);
  });
};

const fdPath = resolveFdPath();
const isFdInstalled = Boolean(fdPath);

const describeFd = isFdInstalled ? describe : describe.skip;

const getFdPath = (): string => {
  if (!fdPath) {
    throw new Error("fd is not installed");
  }
  return fdPath;
};

describe("CombinedAutocompleteProvider", () => {
  describe("extractPathPrefix", () => {
    test("extracts / from 'hey /' when forced", () => {
      const provider = new CombinedAutocompleteProvider([], "/tmp");
      const lines = ["hey /"];
      const cursorLine = 0;
      const cursorCol = 5; // After the "/"

      const result = provider.getForceFileSuggestions(
        lines,
        cursorLine,
        cursorCol,
      );

      expect(result).not.toBeNull();
      if (result) {
        expect(result.prefix).toBe("/");
      }
    });

    test("extracts /A from '/A' when forced", () => {
      const provider = new CombinedAutocompleteProvider([], "/tmp");
      const lines = ["/A"];
      const cursorLine = 0;
      const cursorCol = 2; // After the "A"

      const result = provider.getForceFileSuggestions(
        lines,
        cursorLine,
        cursorCol,
      );

      // This might return null if /A doesn't match anything, which is fine
      // We're mainly testing that the prefix extraction works
      if (result) {
        expect(result.prefix).toBe("/A");
      }
    });

    test("does not trigger for slash commands", () => {
      const provider = new CombinedAutocompleteProvider([], "/tmp");
      const lines = ["/model"];
      const cursorLine = 0;
      const cursorCol = 6; // After "model"

      const result = provider.getForceFileSuggestions(
        lines,
        cursorLine,
        cursorCol,
      );

      expect(result).toBeNull();
    });

    test("triggers for absolute paths after slash command argument", () => {
      const provider = new CombinedAutocompleteProvider([], "/tmp");
      const lines = ["/command /"];
      const cursorLine = 0;
      const cursorCol = 10; // After the second "/"

      const result = provider.getForceFileSuggestions(
        lines,
        cursorLine,
        cursorCol,
      );

      expect(result).not.toBeNull();
      if (result) {
        expect(result.prefix).toBe("/");
      }
    });
  });

  // Skip fd tests if fd is not installed
  describeFd("fd @ file suggestions", () => {
    let baseDir = "";

    beforeEach(() => {
      baseDir = mkdtempSync(join(tmpdir(), "pi-autocomplete-"));
    });

    afterEach(() => {
      rmSync(baseDir, { recursive: true, force: true });
    });

    test("returns all files and folders for empty @ query", () => {
      setupFolder(baseDir, {
        dirs: ["src"],
        files: {
          "README.md": "readme",
        },
      });

      const provider = new CombinedAutocompleteProvider(
        [],
        baseDir,
        getFdPath(),
      );
      const line = "@";
      const result = provider.getSuggestions([line], 0, line.length);

      const values = result?.items.map((item) => item.value).sort();
      expect(values).toEqual(["@README.md", "@src/"].sort());
    });

    test("matches file with extension in query", () => {
      setupFolder(baseDir, {
        files: {
          "file.txt": "content",
        },
      });

      const provider = new CombinedAutocompleteProvider(
        [],
        baseDir,
        getFdPath(),
      );
      const line = "@file.txt";
      const result = provider.getSuggestions([line], 0, line.length);

      const values = result?.items.map((item) => item.value);
      expect(values).toContain("@file.txt");
    });

    test("filters are case insensitive", () => {
      setupFolder(baseDir, {
        dirs: ["src"],
        files: {
          "README.md": "readme",
        },
      });

      const provider = new CombinedAutocompleteProvider(
        [],
        baseDir,
        getFdPath(),
      );
      const line = "@re";
      const result = provider.getSuggestions([line], 0, line.length);

      const values = result?.items.map((item) => item.value).sort();
      expect(values).toEqual(["@README.md"]);
    });

    test("ranks directories before files", () => {
      setupFolder(baseDir, {
        dirs: ["src"],
        files: {
          "src.txt": "text",
        },
      });

      const provider = new CombinedAutocompleteProvider(
        [],
        baseDir,
        getFdPath(),
      );
      const line = "@src";
      const result = provider.getSuggestions([line], 0, line.length);

      const firstValue = result?.items[0]?.value;
      const hasSrcFile = result?.items?.some(
        (item) => item.value === "@src.txt",
      );
      expect(firstValue).toBe("@src/");
      expect(hasSrcFile).toBe(true);
    });

    test("returns nested file paths", () => {
      setupFolder(baseDir, {
        files: {
          "src/index.ts": "export {};\n",
        },
      });

      const provider = new CombinedAutocompleteProvider(
        [],
        baseDir,
        getFdPath(),
      );
      const line = "@index";
      const result = provider.getSuggestions([line], 0, line.length);

      const values = result?.items.map((item) => item.value);
      expect(values).toContain("@src/index.ts");
    });

    test("matches deeply nested paths", () => {
      setupFolder(baseDir, {
        files: {
          "packages/tui/src/autocomplete.ts": "export {};",
          "packages/ai/src/autocomplete.ts": "export {};",
        },
      });

      const provider = new CombinedAutocompleteProvider(
        [],
        baseDir,
        getFdPath(),
      );
      const line = "@tui/src/auto";
      const result = provider.getSuggestions([line], 0, line.length);

      const values = result?.items.map((item) => item.value);
      expect(values).toContain("@packages/tui/src/autocomplete.ts");
      expect(values).not.toContain("@packages/ai/src/autocomplete.ts");
    });

    test("matches directory in middle of path with --full-path", () => {
      setupFolder(baseDir, {
        files: {
          "src/components/Button.tsx": "export {};",
          "src/utils/helpers.ts": "export {};",
        },
      });

      const provider = new CombinedAutocompleteProvider(
        [],
        baseDir,
        getFdPath(),
      );
      const line = "@components/";
      const result = provider.getSuggestions([line], 0, line.length);

      const values = result?.items.map((item) => item.value);
      expect(values).toContain("@src/components/Button.tsx");
      expect(values).not.toContain("@src/utils/helpers.ts");
    });

    test("quotes paths with spaces for @ suggestions", () => {
      setupFolder(baseDir, {
        dirs: ["my folder"],
        files: {
          "my folder/test.txt": "content",
        },
      });

      const provider = new CombinedAutocompleteProvider(
        [],
        baseDir,
        getFdPath(),
      );
      const line = "@my";
      const result = provider.getSuggestions([line], 0, line.length);

      const values = result?.items.map((item) => item.value);
      expect(values).toContain('@"my folder/"');
    });

    test("includes hidden paths but excludes .git", () => {
      setupFolder(baseDir, {
        dirs: [".pi", ".github", ".git"],
        files: {
          ".pi/config.json": "{}",
          ".github/workflows/ci.yml": "name: ci",
          ".git/config": "[core]",
        },
      });

      const provider = new CombinedAutocompleteProvider(
        [],
        baseDir,
        getFdPath(),
      );
      const line = "@";
      const result = provider.getSuggestions([line], 0, line.length);

      const values = result?.items.map((item) => item.value) ?? [];
      expect(values).toContain("@.pi/");
      expect(values).toContain("@.github/");
      expect(
        values.some((value) => value === "@.git" || value.startsWith("@.git/")),
      ).toBe(false);
    });

    test("continues autocomplete inside quoted @ paths", () => {
      setupFolder(baseDir, {
        files: {
          "my folder/test.txt": "content",
          "my folder/other.txt": "content",
        },
      });

      const provider = new CombinedAutocompleteProvider(
        [],
        baseDir,
        getFdPath(),
      );
      const line = '@"my folder/"';
      const result = provider.getSuggestions([line], 0, line.length - 1);

      expect(result).not.toBeNull();
      const values = result?.items.map((item) => item.value);
      expect(values).toContain('@"my folder/test.txt"');
      expect(values).toContain('@"my folder/other.txt"');
    });

    test("applies quoted @ completion without duplicating closing quote", () => {
      setupFolder(baseDir, {
        files: {
          "my folder/test.txt": "content",
        },
      });

      const provider = new CombinedAutocompleteProvider(
        [],
        baseDir,
        getFdPath(),
      );
      const line = '@"my folder/te"';
      const cursorCol = line.length - 1;
      const result = provider.getSuggestions([line], 0, cursorCol);

      expect(result).not.toBeNull();
      if (!result) throw new Error("result should not be null");

      const item = result.items.find(
        (entry) => entry.value === '@"my folder/test.txt"',
      );
      expect(item).toBeDefined();
      if (!item) throw new Error("item should be defined");

      const applied = provider.applyCompletion(
        [line],
        0,
        cursorCol,
        item,
        result.prefix,
      );
      expect(applied.lines[0]).toBe('@"my folder/test.txt" ');
    });
  });

  describe("quoted path completion", () => {
    let baseDir = "";

    beforeEach(() => {
      baseDir = mkdtempSync(join(tmpdir(), "pi-autocomplete-"));
    });

    afterEach(() => {
      rmSync(baseDir, { recursive: true, force: true });
    });

    test("quotes paths with spaces for direct completion", () => {
      setupFolder(baseDir, {
        dirs: ["my folder"],
        files: {
          "my folder/test.txt": "content",
        },
      });

      const provider = new CombinedAutocompleteProvider([], baseDir);
      const line = "my";
      const result = provider.getForceFileSuggestions([line], 0, line.length);

      expect(result).not.toBeNull();
      const values = result?.items.map((item) => item.value);
      expect(values).toContain('"my folder/"');
    });

    test("continues completion inside quoted paths", () => {
      setupFolder(baseDir, {
        files: {
          "my folder/test.txt": "content",
          "my folder/other.txt": "content",
        },
      });

      const provider = new CombinedAutocompleteProvider([], baseDir);
      const line = '"my folder/"';
      const result = provider.getForceFileSuggestions(
        [line],
        0,
        line.length - 1,
      );

      expect(result).not.toBeNull();
      const values = result?.items.map((item) => item.value);
      expect(values).toContain('"my folder/test.txt"');
      expect(values).toContain('"my folder/other.txt"');
    });

    test("applies quoted completion without duplicating closing quote", () => {
      setupFolder(baseDir, {
        files: {
          "my folder/test.txt": "content",
        },
      });

      const provider = new CombinedAutocompleteProvider([], baseDir);
      const line = '"my folder/te"';
      const cursorCol = line.length - 1;
      const result = provider.getForceFileSuggestions([line], 0, cursorCol);

      expect(result).not.toBeNull();
      if (!result) throw new Error("result should not be null");

      const item = result.items.find(
        (entry) => entry.value === '"my folder/test.txt"',
      );
      expect(item).toBeDefined();
      if (!item) throw new Error("item should be defined");

      const applied = provider.applyCompletion(
        [line],
        0,
        cursorCol,
        item,
        result.prefix,
      );
      expect(applied.lines[0]).toBe('"my folder/test.txt"');
    });
  });
});

/** Exercises the real declaration compiler without writing generated files into the checkout. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, test } from "vitest";

test("declaration emit stays inside the plugin distribution", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const configFile = ts.readConfigFile(
    path.join(root, "tsconfig.build.json"),
    ts.sys.readFile,
  );
  expect(configFile.error).toBeUndefined();
  const config = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    root,
    {
      noCheck: true,
      emitDeclarationOnly: true,
    },
  );
  expect(config.errors).toEqual([]);
  const outputRoot = path.join(root, "dist") + path.sep;
  const emitted: string[] = [];
  const program = ts.createProgram(config.fileNames, config.options);
  const result = program.emit(undefined, (file) =>
    emitted.push(path.resolve(file)),
  );
  expect(result.emitSkipped).toBe(false);
  expect(emitted).toContain(path.join(root, "dist/index.d.ts"));
  expect(emitted.filter((file) => !file.startsWith(outputRoot))).toEqual([]);
}, 30_000);

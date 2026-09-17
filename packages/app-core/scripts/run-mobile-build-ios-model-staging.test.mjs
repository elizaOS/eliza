/** Exercises real iOS model staging with filesystem links and relocated application assets. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stageIosBundledLocalModels } from "./mobile/ios/runtime-assets.mjs";

const roots = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

describe("installed iOS model assets", () => {
  it.each(["models", "encoder.bundle"])(
    "copies linked model bytes from %s without depending on the build host",
    (sourceName) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "ios-model-staging-"));
      roots.push(root);
      const source = path.join(root, "build-host", sourceName);
      const cache = path.join(source, ".eliza-embed-bundle", "encoder", "text");
      fs.mkdirSync(cache, { recursive: true });
      const bytes = Buffer.from([0x47, 0x47, 0x55, 0x46, 0, 0xff, 0x10]);
      const model = path.join(source, "encoder.gguf");
      fs.writeFileSync(model, bytes);
      fs.symlinkSync(model, path.join(cache, "encoder.gguf"));
      fs.symlinkSync("encoder.gguf", path.join(source, "alias.gguf"));
      fs.writeFileSync(
        path.join(source, "manifest.json"),
        '{"model":"encoder.gguf"}',
      );
      vi.stubEnv("ELIZA_IOS_BUNDLED_MODELS_DIR", source);
      vi.stubEnv("ELIZA_IOS_REQUIRE_LOCAL_MODELS", "1");
      const staged = path.join(root, "App.app", "public", "agent");
      expect(stageIosBundledLocalModels(staged)).toBe(3);
      const models = path.join(
        staged,
        "models",
        sourceName.endsWith(".bundle") ? sourceName : "",
      );
      fs.rmSync(path.join(root, "build-host"), { recursive: true });
      for (const relative of [
        "encoder.gguf",
        "alias.gguf",
        ".eliza-embed-bundle/encoder/text/encoder.gguf",
      ]) {
        const installed = path.join(models, relative);
        expect(fs.lstatSync(installed).isSymbolicLink()).toBe(false);
        expect(fs.readFileSync(installed)).toEqual(bytes);
      }
      expect(
        JSON.parse(fs.readFileSync(path.join(models, "manifest.json"), "utf8")),
      ).toEqual({ model: "encoder.gguf" });
    },
  );
});

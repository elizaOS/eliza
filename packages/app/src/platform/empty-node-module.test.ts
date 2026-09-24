import { describe, expect, it } from "vitest";
import server, {
  createZipArchive,
  finished,
  getDocumentsService,
  loadElizaConfig,
  pipeline,
  saveElizaConfig,
  startEliza,
  validatePluginConfig,
} from "./empty-node-module";

describe("browser server boundary", () => {
  it.each([
    createZipArchive,
    getDocumentsService,
    loadElizaConfig,
    saveElizaConfig,
    startEliza,
    validatePluginConfig,
    server,
  ])(
    "rejects unsupported calls instead of fabricating empty results",
    (call) => {
      expect(call).toThrow(
        expect.objectContaining({
          code: "BROWSER_SERVER_OPERATION_UNAVAILABLE",
        }),
      );
    },
  );

  it.each([pipeline, finished])(
    "rejects unsupported asynchronous work",
    async (call) => {
      await expect(call()).rejects.toMatchObject({
        code: "BROWSER_SERVER_OPERATION_UNAVAILABLE",
      });
    },
  );
});

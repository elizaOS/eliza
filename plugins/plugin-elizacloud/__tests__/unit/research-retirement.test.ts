/**
 * Proves the retired Cloud research imports remain resolvable under source
 * conditions and fail with an explicit typed-unavailable contract.
 */
import { getResearchModel } from "@elizaos/plugin-elizacloud/endpoint-config";
import { handleResearch as handleResearchFromBarrel } from "@elizaos/plugin-elizacloud/models/index";
import { handleResearch } from "@elizaos/plugin-elizacloud/models/research";
import { describe, expect, it } from "vitest";

describe("retired Cloud research compatibility", () => {
  it.each([handleResearch, handleResearchFromBarrel])(
    "keeps the handler import but rejects with a typed unavailable error",
    async (handler) => {
      await expect(handler({} as never, {} as never)).rejects.toMatchObject({
        code: "ELIZA_CLOUD_RESEARCH_UNAVAILABLE",
      });
    }
  );

  it("keeps the legacy model getter but refuses to select an ordinary text model", () => {
    expect(() => getResearchModel({} as never)).toThrowError(
      expect.objectContaining({
        code: "ELIZA_CLOUD_RESEARCH_UNAVAILABLE",
      })
    );
  });
});

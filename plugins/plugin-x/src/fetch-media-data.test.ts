/**
 * Coverage for {@link fetchMediaData}: attachments resolve through the core
 * outbound loader, so the MIME type comes from the bytes.
 */

import { describe, expect, it } from "vitest";
import { fetchMediaData } from "./utils";

describe("fetchMediaData", () => {
  it("decodes a data URL with its real MIME type, not the coarse media kind", async () => {
    await expect(
      fetchMediaData([
        {
          id: "att-1",
          url: `data:image/png;base64,${Buffer.from("png").toString("base64")}`,
          contentType: "image" as never,
        },
      ]),
    ).resolves.toEqual([{ data: Buffer.from("png"), mediaType: "image/png" }]);
  });
});

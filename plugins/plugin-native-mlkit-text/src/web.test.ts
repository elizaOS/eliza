import { describe, expect, it } from "vitest";
import { MlKitTextWeb } from "./web";

describe("MlKitTextWeb", () => {
  it("fails clearly outside Android", async () => {
    const plugin = new MlKitTextWeb();
    await expect(plugin.recognize({ image: "abcd" })).rejects.toThrow(
      "only available on Android",
    );
  });
});

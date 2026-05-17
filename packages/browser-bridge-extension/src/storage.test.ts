import { describe, expect, it } from "vitest";
import { candidateApiBaseUrlsFromTabs } from "./storage";

describe("candidateApiBaseUrlsFromTabs", () => {
  it("deduplicates likely Eliza tabs before loopback fallbacks", () => {
    expect(
      candidateApiBaseUrlsFromTabs([
        { title: "Eliza", url: "http://localhost:3000" },
        { title: "LifeOps", url: "http://localhost:3000/settings" },
        { title: "Other", url: "http://127.0.0.1:31337" },
      ]),
    ).toEqual(["http://localhost:3000", "http://127.0.0.1:31337"]);
  });
});

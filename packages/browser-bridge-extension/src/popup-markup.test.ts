/**
 * Static DOM contract for the minimal default surface and transient, collapsed
 * pairing recovery path; stored credentials have no field or value to render.
 */
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

async function loadPopupDocument(): Promise<Document> {
  const html = await readFile(
    new URL("../public/popup.html", import.meta.url),
    "utf8",
  );
  return new JSDOM(html).window.document;
}

describe("popup markup", () => {
  it("has one hidden default action and collapsed native details", async () => {
    const document = await loadPopupDocument();
    const actions = [...document.querySelectorAll("#primaryAction")];
    expect(actions).toHaveLength(1);
    expect(actions[0]?.hasAttribute("hidden")).toBe(true);
    expect(document.querySelector("#details")?.tagName).toBe("DETAILS");
    expect(document.querySelector("#details")?.hasAttribute("open")).toBe(
      false,
    );
    expect(document.querySelector("#recovery")?.hasAttribute("open")).toBe(
      false,
    );
  });

  it("contains no stored-secret fields or prepopulated recovery value", async () => {
    const document = await loadPopupDocument();
    expect(document.querySelector("input[type='password']")).toBeNull();
    expect(document.querySelector("#pairingToken")).toBeNull();
    expect(document.querySelector("#companionId")).toBeNull();
    expect(document.querySelector("#apiBaseUrl")).toBeNull();
    const recovery =
      document.querySelector<HTMLTextAreaElement>("#pairingJson");
    expect(recovery?.value).toBe("");
    expect(recovery?.closest("details")?.hasAttribute("open")).toBe(false);
  });

  it("announces the atomic one-line status", async () => {
    const status = (await loadPopupDocument()).querySelector("#statusTitle");
    expect(status?.getAttribute("role")).toBe("status");
    expect(status?.getAttribute("aria-live")).toBe("polite");
    expect(status?.getAttribute("aria-atomic")).toBe("true");
  });
});

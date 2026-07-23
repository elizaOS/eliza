/** Exercises the download manifest's available and unavailable UI states. */
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

vi.mock("./providers/I18nProvider", () => ({
  useT:
    () => (_key: string, options: { defaultValue: string; date?: string }) =>
      options.defaultValue.replace("{{date}}", options.date ?? ""),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("OS release downloads", () => {
  it("renders a visibly unavailable state when the manifest cannot load", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    render(<App />);

    const unavailableMessage = screen.getByText(
      "Downloads are temporarily unavailable.",
    );
    const downloadSection = unavailableMessage.closest("section");
    expect(downloadSection).not.toBeNull();
    const downloads = within(downloadSection as HTMLElement);
    expect(downloads.getAllByText("Unavailable")).toHaveLength(4);
    expect(downloads.queryByRole("link", { name: "Download" })).toBeNull();
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  });

  it("renders download and checksum links from an available manifest", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          product: "elizaOS",
          channel: "stable",
          availableFrom: "2026-07-22",
          artifacts: [
            {
              id: "linux-x64",
              label: "Linux image",
              kind: "raw-image",
              platform: "linux-bare-metal",
              architecture: "x86_64",
              url: "https://downloads.example/elizaos.img",
              checksumUrl: "https://downloads.example/SHA256SUMS.txt",
            },
          ],
        }),
      }),
    );

    render(<App />);

    const availableMessage = await screen.findByText(
      "Available July 22, 2026.",
    );
    const downloadSection = availableMessage.closest("section");
    expect(downloadSection).not.toBeNull();
    const downloads = within(downloadSection as HTMLElement);
    expect(
      downloads.getByRole("link", { name: "Download" }).getAttribute("href"),
    ).toBe("https://downloads.example/elizaos.img");
    expect(
      downloads.getByRole("link", { name: "SHA256" }).getAttribute("href"),
    ).toBe("https://downloads.example/SHA256SUMS.txt");
    expect(downloads.getByText("Linux Bare Metal")).toBeDefined();
  });
});

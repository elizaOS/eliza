// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client } from "../../api";
import type {
  ActiveModelState,
  CatalogModel,
  HardwareProbe,
} from "../../api/client-local-inference";
import { CustomModelSearch } from "./CustomModelSearch";

vi.mock("../../api", () => ({
  client: {
    searchHuggingFaceGguf: vi.fn(),
  },
}));

const searchHuggingFaceGguf = vi.mocked(client.searchHuggingFaceGguf);

const hardware: HardwareProbe = {
  totalRamGb: 64,
  freeRamGb: 48,
  gpu: null,
  cpuCores: 8,
  platform: "darwin",
  arch: "arm64",
  appleSilicon: true,
  recommendedBucket: "large",
  source: "os-fallback",
};

const active: ActiveModelState = {
  modelId: null,
  loadedAt: null,
  status: "idle",
};

const hfModel: CatalogModel = {
  id: "hf:Qwen/Qwen3.5-0.8B-GGUF::qwen3.5-0.8b-q4_k_m.gguf",
  displayName: "Qwen3.5 0.8B GGUF",
  hfRepo: "Qwen/Qwen3.5-0.8B-GGUF",
  ggufFile: "qwen3.5-0.8b-q4_k_m.gguf",
  params: "0.8B",
  quant: "Q4_K_M",
  sizeGb: 0.5,
  minRamGb: 4,
  category: "chat",
  bucket: "small",
  blurb: "Custom GGUF search result.",
};

function renderSearch(
  overrides: { onDownload?: (model: CatalogModel) => void } = {},
) {
  return render(
    <CustomModelSearch
      installed={[]}
      downloads={[]}
      active={active}
      hardware={hardware}
      onDownload={overrides.onDownload ?? vi.fn()}
      onCancel={vi.fn()}
      onActivate={vi.fn()}
      onUninstall={vi.fn()}
      busy={false}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("CustomModelSearch", () => {
  it("searches Hugging Face explicitly and downloads the selected result spec", async () => {
    vi.useFakeTimers();
    const onDownload = vi.fn();
    searchHuggingFaceGguf.mockResolvedValue({ models: [hfModel] });
    renderSearch({ onDownload });

    fireEvent.change(
      screen.getByPlaceholderText("Search custom Hugging Face GGUF repos"),
      { target: { value: "qwen" } },
    );
    await act(async () => {
      vi.advanceTimersByTime(450);
      await Promise.resolve();
    });

    expect(screen.getByText("Qwen3.5 0.8B GGUF")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Download" }));

    expect(searchHuggingFaceGguf).toHaveBeenCalledWith(
      "qwen",
      undefined,
      "huggingface",
    );
    expect(onDownload).toHaveBeenCalledWith(hfModel);
  });

  it("searches ModelScope explicitly but disables direct downloads", async () => {
    vi.useFakeTimers();
    const onDownload = vi.fn();
    const msModel: CatalogModel = {
      ...hfModel,
      id: "modelscope:Qwen/Qwen3.5-0.8B-GGUF::qwen3.5-0.8b-q4_k_m.gguf",
      displayName: "ModelScope Qwen3.5 0.8B GGUF",
      hub: "modelscope",
      hfRepo: "Qwen/Qwen3.5-0.8B-GGUF",
    };
    searchHuggingFaceGguf.mockResolvedValue({ models: [msModel] });
    renderSearch({ onDownload });

    fireEvent.click(screen.getByRole("button", { name: "ModelScope" }));
    fireEvent.change(
      screen.getByPlaceholderText("Search ModelScope owner or owner/model"),
      { target: { value: "Qwen/Qwen3.5-0.8B-GGUF" } },
    );
    await act(async () => {
      vi.advanceTimersByTime(450);
      await Promise.resolve();
    });

    expect(searchHuggingFaceGguf).toHaveBeenCalledWith(
      "Qwen/Qwen3.5-0.8B-GGUF",
      undefined,
      "modelscope",
    );
    expect(screen.getByText("ModelScope Qwen3.5 0.8B GGUF")).toBeTruthy();
    const download = screen.getByRole("button", {
      name: "Download unavailable",
    }) as HTMLButtonElement;
    expect(download.disabled).toBe(true);
    fireEvent.click(download);
    expect(onDownload).not.toHaveBeenCalled();
  });
});

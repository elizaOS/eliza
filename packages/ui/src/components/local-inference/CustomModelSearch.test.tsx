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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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

  it("searches ModelScope explicitly and routes downloads through the hub downloader", async () => {
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
      name: "Download",
    }) as HTMLButtonElement;
    expect(download.disabled).toBe(false);
    fireEvent.click(download);
    expect(onDownload).toHaveBeenCalledWith(msModel);
  });

  it("does not render a completed stale search while the next query is debouncing", async () => {
    vi.useFakeTimers();
    const first = deferred<{ models: CatalogModel[] }>();
    const nextModel: CatalogModel = {
      ...hfModel,
      id: "hf:Meta/Llama-3.2-1B-GGUF::llama-3.2-1b-q4_k_m.gguf",
      displayName: "Llama 3.2 1B GGUF",
      hfRepo: "Meta/Llama-3.2-1B-GGUF",
      ggufFile: "llama-3.2-1b-q4_k_m.gguf",
      params: "1B",
    };
    const second = deferred<{ models: CatalogModel[] }>();
    searchHuggingFaceGguf
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    renderSearch();

    const input = screen.getByPlaceholderText(
      "Search custom Hugging Face GGUF repos",
    );
    fireEvent.change(input, { target: { value: "qwen" } });
    await act(async () => {
      vi.advanceTimersByTime(450);
      await Promise.resolve();
    });

    fireEvent.change(input, { target: { value: "llama" } });
    await act(async () => {
      first.resolve({ models: [hfModel] });
      await first.promise;
    });

    expect(screen.queryByText("Qwen3.5 0.8B GGUF")).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(450);
      await Promise.resolve();
    });
    await act(async () => {
      second.resolve({ models: [nextModel] });
      await second.promise;
    });

    expect(screen.getByText("Llama 3.2 1B GGUF")).toBeTruthy();
  });

  it("hides completed results immediately after the user starts a different valid query", async () => {
    vi.useFakeTimers();
    const nextModel: CatalogModel = {
      ...hfModel,
      id: "hf:Meta/Llama-3.2-1B-GGUF::llama-3.2-1b-q4_k_m.gguf",
      displayName: "Llama 3.2 1B GGUF",
      hfRepo: "Meta/Llama-3.2-1B-GGUF",
      ggufFile: "llama-3.2-1b-q4_k_m.gguf",
      params: "1B",
    };
    searchHuggingFaceGguf
      .mockResolvedValueOnce({ models: [hfModel] })
      .mockResolvedValueOnce({ models: [nextModel] });
    renderSearch();

    const input = screen.getByPlaceholderText(
      "Search custom Hugging Face GGUF repos",
    );
    fireEvent.change(input, { target: { value: "qwen" } });
    await act(async () => {
      vi.advanceTimersByTime(450);
      await Promise.resolve();
    });

    expect(screen.getByText("Qwen3.5 0.8B GGUF")).toBeTruthy();

    fireEvent.change(input, { target: { value: "llama" } });
    expect(screen.queryByText("Qwen3.5 0.8B GGUF")).toBeNull();
    expect(screen.queryByRole("button", { name: "Download" })).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(450);
      await Promise.resolve();
    });

    expect(screen.getByText("Llama 3.2 1B GGUF")).toBeTruthy();
  });
});

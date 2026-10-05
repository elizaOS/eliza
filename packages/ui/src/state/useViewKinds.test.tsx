// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { useEnabledViewKinds } from "./useViewKinds";

beforeEach(() => {
  localStorage.clear();
  window.dispatchEvent(
    new StorageEvent("storage", { key: null, storageArea: localStorage }),
  );
});
afterEach(cleanup);

it("restores independent opt-in flags and updates subscribers on storage changes", async () => {
  localStorage.setItem("eliza:previewMode", "1");
  window.dispatchEvent(
    new StorageEvent("storage", { key: null, storageArea: localStorage }),
  );
  const { result, rerender } = renderHook(useEnabledViewKinds);
  expect(result.current).toEqual({ developer: false, preview: true });
  const initial = result.current;
  rerender();
  expect(result.current).toBe(initial);
  act(() => {
    localStorage.setItem("eliza:developerMode", "1");
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "eliza:developerMode",
        storageArea: localStorage,
      }),
    );
  });
  expect(result.current).toEqual({ developer: true, preview: true });
  act(() => {
    localStorage.clear();
    window.dispatchEvent(
      new StorageEvent("storage", { key: null, storageArea: localStorage }),
    );
  });
  expect(result.current).toEqual({ developer: false, preview: false });
});

it("defaults to disabled when storage is unavailable", async () => {
  const read = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("unavailable");
  });
  try {
    window.dispatchEvent(
      new StorageEvent("storage", { key: null, storageArea: localStorage }),
    );
    const { result } = renderHook(useEnabledViewKinds);
    expect(result.current).toEqual({ developer: false, preview: false });
  } finally {
    read.mockRestore();
  }
});

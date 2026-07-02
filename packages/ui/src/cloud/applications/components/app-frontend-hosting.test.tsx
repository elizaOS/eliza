// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

// --- collaborator doubles (hoisted so vi.mock factories can close over them) ---
const apiMock = vi.hoisted(() => vi.fn());
const toastSuccessMock = vi.hoisted(() => vi.fn());
const toastErrorMock = vi.hoisted(() => vi.fn());

vi.mock("../../lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("../../lib/api-client")>(
    "../../lib/api-client",
  );
  return { ...actual, api: (...args: unknown[]) => apiMock(...args) };
});
vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccessMock(...args),
    error: (...args: unknown[]) => toastErrorMock(...args),
  },
}));
// t() returns the defaultValue with {{vars}} interpolated so assertions read
// real copy. The translator identity is STABLE across renders — the component
// legitimately lists `t` as a hook dependency, so a fresh function per render
// would refetch forever.
vi.mock("../../shell/CloudI18nProvider", () => {
  const t = (
    _k: string,
    o?: Record<string, unknown> & { defaultValue?: string },
  ) => {
    let s = o?.defaultValue ?? _k;
    if (o) {
      for (const [key, val] of Object.entries(o)) {
        if (key !== "defaultValue") {
          s = s.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), String(val));
        }
      }
    }
    return s;
  };
  return { useCloudT: () => t };
});

import { ApiError } from "../../lib/api-client";
import type { FrontendDeployment } from "../lib/frontend-hosting";
import {
  FRONTEND_BUNDLE_LIMITS,
  filesToBundle,
  stripCommonRootDir,
} from "../lib/frontend-hosting";
import { AppFrontendHosting } from "./app-frontend-hosting";

const APP_ID = "app_1";

function deployment(
  overrides: Partial<FrontendDeployment> & { id: string; version: number },
): FrontendDeployment {
  return {
    app_id: APP_ID,
    status: "ready",
    file_count: 3,
    total_bytes: 2048,
    build_meta: { source: "dashboard" },
    error: null,
    created_at: "2026-06-30T12:00:00.000Z",
    activated_at: null,
    finalized_at: "2026-06-30T12:00:01.000Z",
    ...overrides,
  };
}

function mockList(
  deployments: FrontendDeployment[],
  activeId: string | null = null,
) {
  apiMock.mockResolvedValueOnce({
    success: true,
    active_deployment_id: activeId,
    deployments,
  });
}

function pickFiles(files: File[]) {
  const input = screen.getByTestId("hosting-files-input");
  fireEvent.change(input, { target: { files } });
}

afterEach(() => {
  cleanup();
  apiMock.mockReset();
  toastSuccessMock.mockReset();
  toastErrorMock.mockReset();
});

describe("AppFrontendHosting (#10690)", () => {
  it("lists deployments newest-first with a live badge on the active one", async () => {
    const v2 = deployment({ id: "dep_2", version: 2, status: "active" });
    const v1 = deployment({ id: "dep_1", version: 1, status: "superseded" });
    mockList([v2, v1], "dep_2");

    render(<AppFrontendHosting appId={APP_ID} />);

    expect(await screen.findByText("v2")).toBeTruthy();
    expect(screen.getByText("v1")).toBeTruthy();
    expect(apiMock).toHaveBeenCalledWith(`/api/v1/apps/${APP_ID}/frontend`);
    // Active row shows "live", not the raw status string.
    expect(screen.getByText("live")).toBeTruthy();
    // Active row has no delete button; superseded row has one.
    expect(screen.queryByTestId("hosting-delete-2")).toBeNull();
    expect(screen.getByTestId("hosting-delete-1")).toBeTruthy();
  });

  it("shows the empty state when there are no deployments", async () => {
    mockList([]);
    render(<AppFrontendHosting appId={APP_ID} />);
    expect(await screen.findByText("No deployments yet")).toBeTruthy();
  });

  it("surfaces a load error and recovers via Retry", async () => {
    apiMock.mockRejectedValueOnce(
      new ApiError(500, "HTTP_500", "database exploded"),
    );
    render(<AppFrontendHosting appId={APP_ID} />);

    expect(await screen.findByText("database exploded")).toBeTruthy();

    mockList(
      [deployment({ id: "dep_1", version: 1, status: "active" })],
      "dep_1",
    );
    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole("button", { name: /Retry/i }));
    expect(await screen.findByText("v1")).toBeTruthy();
  });

  it("publishes picked files as a base64 bundle (activate on) and refreshes", async () => {
    mockList([]);
    render(<AppFrontendHosting appId={APP_ID} />);
    await screen.findByText("No deployments yet");

    pickFiles([
      new File(["<html>hi</html>"], "index.html", { type: "text/html" }),
    ]);
    expect(await screen.findByTestId("hosting-selection-summary")).toBeTruthy();

    apiMock.mockResolvedValueOnce({
      success: true,
      deployment: deployment({ id: "dep_1", version: 1, status: "active" }),
    });
    mockList(
      [deployment({ id: "dep_1", version: 1, status: "active" })],
      "dep_1",
    );

    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByTestId("hosting-publish"));

    await waitFor(() => expect(toastSuccessMock).toHaveBeenCalled());
    const publishCall = apiMock.mock.calls.find(
      ([, init]) => (init as { method?: string })?.method === "POST",
    );
    expect(publishCall?.[0]).toBe(`/api/v1/apps/${APP_ID}/frontend`);
    const body = (
      publishCall?.[1] as {
        json: {
          files: Array<{ path: string; content: string; encoding: string }>;
          activate: boolean;
          buildMeta: { source: string };
        };
      }
    ).json;
    expect(body.activate).toBe(true);
    expect(body.buildMeta.source).toBe("dashboard");
    expect(body.files).toHaveLength(1);
    expect(body.files[0].path).toBe("index.html");
    expect(body.files[0].encoding).toBe("base64");
    expect(atob(body.files[0].content)).toBe("<html>hi</html>");
    expect(toastSuccessMock).toHaveBeenCalledWith("Version 1 published");
    // List refreshed after publish.
    expect(await screen.findByText("v1")).toBeTruthy();
  });

  it("publishes with activate=false when the checkbox is unticked", async () => {
    mockList([]);
    render(<AppFrontendHosting appId={APP_ID} />);
    await screen.findByText("No deployments yet");

    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole("checkbox"));
    pickFiles([new File(["x"], "index.html", { type: "text/html" })]);
    await screen.findByTestId("hosting-selection-summary");

    apiMock.mockResolvedValueOnce({
      success: true,
      deployment: deployment({ id: "dep_1", version: 1 }),
    });
    mockList([deployment({ id: "dep_1", version: 1 })]);
    await user.click(screen.getByTestId("hosting-publish"));

    await waitFor(() => expect(toastSuccessMock).toHaveBeenCalled());
    const publishCall = apiMock.mock.calls.find(
      ([, init]) => (init as { method?: string })?.method === "POST",
    );
    expect(
      (publishCall?.[1] as { json: { activate: boolean } }).json.activate,
    ).toBe(false);
  });

  it("surfaces a server publish failure via toast and keeps the selection", async () => {
    mockList([]);
    render(<AppFrontendHosting appId={APP_ID} />);
    await screen.findByText("No deployments yet");

    pickFiles([new File(["x"], "index.html", { type: "text/html" })]);
    await screen.findByTestId("hosting-selection-summary");

    apiMock.mockRejectedValueOnce(
      new ApiError(400, "HTTP_400", "Invalid request"),
    );
    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByTestId("hosting-publish"));

    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith("Invalid request"),
    );
    // Selection is retained so the user can retry.
    expect(screen.getByTestId("hosting-selection-summary")).toBeTruthy();
  });

  it("activates an older ready version through the rollback confirm", async () => {
    const v2 = deployment({ id: "dep_2", version: 2, status: "active" });
    const v1 = deployment({ id: "dep_1", version: 1, status: "superseded" });
    mockList([v2, v1], "dep_2");

    render(<AppFrontendHosting appId={APP_ID} />);
    await screen.findByText("v2");

    // The older version's action reads "Roll back", not "Activate".
    const rollback = screen.getByTestId("hosting-activate-1");
    expect(rollback.textContent).toContain("Roll back");

    const user = userEvent.setup({ delay: null });
    await user.click(rollback);
    expect(await screen.findByText("Make version 1 live?")).toBeTruthy();

    apiMock.mockResolvedValueOnce({
      success: true,
      deployment: deployment({ id: "dep_1", version: 1, status: "active" }),
    });
    mockList(
      [
        deployment({ id: "dep_2", version: 2, status: "superseded" }),
        deployment({ id: "dep_1", version: 1, status: "active" }),
      ],
      "dep_1",
    );
    await user.click(screen.getByTestId("hosting-activate-confirm"));

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        `/api/v1/apps/${APP_ID}/frontend/dep_1/activate`,
        { method: "POST" },
      ),
    );
    expect(toastSuccessMock).toHaveBeenCalledWith("Version 1 is now live");
  });

  it("deletes a non-active version after confirm", async () => {
    const v2 = deployment({ id: "dep_2", version: 2, status: "active" });
    const v1 = deployment({ id: "dep_1", version: 1, status: "superseded" });
    mockList([v2, v1], "dep_2");

    render(<AppFrontendHosting appId={APP_ID} />);
    await screen.findByText("v2");

    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByTestId("hosting-delete-1"));
    expect(await screen.findByText("Delete version 1?")).toBeTruthy();

    apiMock.mockResolvedValueOnce({ success: true });
    mockList([v2], "dep_2");
    await user.click(screen.getByTestId("hosting-delete-confirm"));

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        `/api/v1/apps/${APP_ID}/frontend/dep_1`,
        { method: "DELETE" },
      ),
    );
    expect(toastSuccessMock).toHaveBeenCalledWith("Version 1 deleted");
  });

  it("surfaces the server 409 when deleting a version that became active", async () => {
    const v2 = deployment({ id: "dep_2", version: 2, status: "active" });
    const v1 = deployment({ id: "dep_1", version: 1, status: "superseded" });
    mockList([v2, v1], "dep_2");

    render(<AppFrontendHosting appId={APP_ID} />);
    await screen.findByText("v2");

    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByTestId("hosting-delete-1"));
    apiMock.mockRejectedValueOnce(
      new ApiError(
        409,
        "HTTP_409",
        "Cannot delete the active deployment; activate another first",
      ),
    );
    await user.click(await screen.findByTestId("hosting-delete-confirm"));

    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith(
        "Cannot delete the active deployment; activate another first",
      ),
    );
  });

  it("shows the failure reason on a failed deployment row", async () => {
    mockList([
      deployment({
        id: "dep_1",
        version: 1,
        status: "failed",
        error: "Bundle exceeds limits",
      }),
    ]);
    render(<AppFrontendHosting appId={APP_ID} />);
    expect(await screen.findByText("Bundle exceeds limits")).toBeTruthy();
    // A failed deployment is not activatable.
    expect(screen.queryByTestId("hosting-activate-1")).toBeNull();
  });
});

describe("filesToBundle / stripCommonRootDir", () => {
  it("strips a single shared root directory (folder upload)", () => {
    expect(
      stripCommonRootDir(["dist/index.html", "dist/assets/app.js"]),
    ).toEqual(["index.html", "assets/app.js"]);
  });

  it("leaves paths untouched when files do not share one root", () => {
    expect(stripCommonRootDir(["index.html", "assets/app.js"])).toEqual([
      "index.html",
      "assets/app.js",
    ]);
  });

  it("encodes file content as base64 with contentType passthrough", async () => {
    const bundle = await filesToBundle([
      new File(["body { color: red }"], "app.css", { type: "text/css" }),
    ]);
    expect(bundle).toHaveLength(1);
    expect(bundle[0]).toMatchObject({
      path: "app.css",
      encoding: "base64",
      contentType: "text/css",
    });
    expect(atob(bundle[0].content)).toBe("body { color: red }");
  });

  it("rejects an empty selection", async () => {
    await expect(filesToBundle([])).rejects.toThrow("bundle_empty");
  });

  it("rejects a bundle over the total-bytes limit without reading content", async () => {
    const big = new File([""], "big.bin");
    Object.defineProperty(big, "size", {
      value: FRONTEND_BUNDLE_LIMITS.maxTotalBytes + 1,
    });
    await expect(filesToBundle([big])).rejects.toThrow("bundle_too_large");
  });

  it("rejects a single file over the per-file limit", async () => {
    const a = new File([""], "a.bin");
    const b = new File([""], "b.bin");
    Object.defineProperty(b, "size", {
      value: FRONTEND_BUNDLE_LIMITS.maxFileBytes + 1,
    });
    await expect(filesToBundle([a, b])).rejects.toThrow(
      "bundle_file_too_large",
    );
  });

  it("rejects more files than the server accepts", async () => {
    const files = Array.from(
      { length: FRONTEND_BUNDLE_LIMITS.maxFiles + 1 },
      (_, i) => new File(["x"], `f${i}.txt`),
    );
    await expect(filesToBundle(files)).rejects.toThrow("bundle_too_many_files");
  });
});

/**
 * Client-scoped shell-state publication tests. These use real Request bodies
 * and deterministic response objects while injecting the HTTP boundary.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetAuthoritativeShellViewStateForTests,
  ensureAuthoritativeShellViewState,
  rehydrateAuthoritativeShellViewState,
  setAuthoritativeShellViewState,
} from "./view-shell-state";

type ViewStateRequest = (
  path: string,
  init: RequestInit,
  options: { allowNonOk: true },
) => Promise<Response>;

function successfulRequest() {
  return vi.fn<ViewStateRequest>(async () =>
    Promise.resolve(new Response("{}", { status: 200 })),
  );
}

afterEach(() => {
  __resetAuthoritativeShellViewStateForTests();
});

describe("authoritative shell view rehydrate", () => {
  it("publishes a fresh single-view reload without an agent navigation echo", async () => {
    const request = successfulRequest();
    setAuthoritativeShellViewState({
      viewId: "notes",
      viewPath: "/notes",
      viewType: "gui",
    });

    await expect(
      rehydrateAuthoritativeShellViewState({ request }),
    ).resolves.toBe(true);

    expect(request).toHaveBeenCalledWith(
      "/api/views/notes/navigate",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          source: "user",
          rehydrate: true,
          path: "/notes",
          viewType: "gui",
        }),
      }),
      { allowNonOk: true },
    );
  });

  it("republishes the exact split panes, types, and geometry after backend state loss", async () => {
    const request = successfulRequest();
    setAuthoritativeShellViewState({
      viewId: "notes",
      viewPath: "/notes",
      viewType: "gui",
      mode: "split",
      panes: [
        { viewId: "notes", viewType: "gui" },
        { viewId: "simple-calendar", viewType: "gui" },
      ],
      layout: "horizontal",
      placement: "right",
    });

    await rehydrateAuthoritativeShellViewState({ request });

    expect(JSON.parse(request.mock.calls[0]?.[1].body as string)).toEqual({
      source: "user",
      rehydrate: true,
      path: "/notes",
      viewType: "gui",
      action: "split-view",
      views: ["notes", "simple-calendar"],
      viewTypes: { notes: "gui", "simple-calendar": "gui" },
      layout: "horizontal",
      placement: "right",
    });
  });

  it("serializes an in-flight reload before the latest pre-chat snapshot", async () => {
    let releaseFirst: (() => void) | undefined;
    const request = vi
      .fn<ViewStateRequest>()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            releaseFirst = () => resolve(new Response("{}", { status: 200 }));
          }),
      )
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));

    setAuthoritativeShellViewState({
      viewId: "notes",
      viewPath: "/notes",
      viewType: "gui",
    });
    const reload = rehydrateAuthoritativeShellViewState({ request });
    setAuthoritativeShellViewState({
      viewId: "simple-calendar",
      viewPath: "/simple-calendar",
      viewType: "gui",
    });
    const beforeChat = ensureAuthoritativeShellViewState({ request });

    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(1);
    releaseFirst?.();
    await expect(Promise.all([reload, beforeChat])).resolves.toEqual([
      true,
      true,
    ]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]?.[0]).toBe(
      "/api/views/simple-calendar/navigate",
    );
  });

  it("treats an unsupported shell registry as a safe no-op", async () => {
    setAuthoritativeShellViewState({
      viewId: "notes",
      viewPath: "/notes",
      viewType: "gui",
    });

    await expect(
      rehydrateAuthoritativeShellViewState({
        request: async () => new Response("", { status: 404 }),
      }),
    ).resolves.toBe(false);
  });
});

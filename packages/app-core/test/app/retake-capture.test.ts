// @vitest-environment jsdom

import { useRetakeCapture } from "@elizaos/app-core/hooks";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function HookHost({
  iframeRef,
  active,
  fps,
}: {
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
  active: boolean;
  fps?: number;
}) {
  useRetakeCapture(iframeRef, active, fps);
  return null;
}

describe("useRetakeCapture", () => {
  const mockStart = vi.fn().mockResolvedValue(undefined);
  const mockStop = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    Object.defineProperty(window, "__ELIZA_ELECTROBUN_RPC__", {
      value: {
        request: {
          screencaptureStartFrameCapture: mockStart,
          screencaptureStopFrameCapture: mockStop,
        },
        onMessage: vi.fn(),
        offMessage: vi.fn(),
      },
      writable: true,
      configurable: true,
    });
    mockStart.mockReset().mockResolvedValue(undefined);
    mockStop.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // @ts-expect-error cleanup rpc stub
    delete window.__ELIZA_ELECTROBUN_RPC__;
  });

  it("does not start capture when active is false", () => {
    const iframeRef = {
      current: null,
    } as React.RefObject<HTMLIFrameElement | null>;

    act(() => {
      TestRenderer.create(
        React.createElement(HookHost, { iframeRef, active: false }),
      );
    });

    expect(mockStart).not.toHaveBeenCalled();
  });

  it("cleans up capture on unmount", () => {
    const iframeRef = {
      current: null,
    } as React.RefObject<HTMLIFrameElement | null>;

    let renderer: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(HookHost, { iframeRef, active: true }),
      );
    });

    expect(mockStart).toHaveBeenCalledWith(
      expect.objectContaining({ fps: expect.any(Number) }),
    );

    act(() => {
      renderer.unmount();
    });

    expect(mockStop).toHaveBeenCalledWith(undefined);
  });
});

import type { VRM } from "@pixiv/three-vrm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  gltfParseAsyncMock: vi.fn(),
  fbxParseMock: vi.fn(),
  retargetGltfMock: vi.fn(),
  retargetFbxMock: vi.fn(),
}));

vi.mock("three/examples/jsm/loaders/GLTFLoader.js", () => ({
  GLTFLoader: class MockGLTFLoader {
    parseAsync = hoisted.gltfParseAsyncMock;
  },
}));

vi.mock("three/examples/jsm/loaders/FBXLoader.js", () => ({
  FBXLoader: class MockFBXLoader {
    parse = hoisted.fbxParseMock;
  },
}));

vi.mock("./retargetMixamoGltfToVrm", () => ({
  retargetMixamoGltfToVrm: hoisted.retargetGltfMock,
}));

vi.mock("./retargetMixamoFbxToVrm", () => ({
  retargetMixamoFbxToVrm: hoisted.retargetFbxMock,
}));

import { loadEmoteClip, loadIdleClip } from "./VrmAnimationLoader";

describe("VrmAnimationLoader", () => {
  const originalFetch = globalThis.fetch;
  const originalDecompressionStream = globalThis.DecompressionStream;

  beforeEach(() => {
    vi.restoreAllMocks();
    hoisted.fetchMock.mockReset();
    hoisted.gltfParseAsyncMock.mockReset();
    hoisted.fbxParseMock.mockReset();
    hoisted.retargetGltfMock.mockReset();
    hoisted.retargetFbxMock.mockReset();
    Object.assign(globalThis, {
      fetch: hoisted.fetchMock,
    });
  });

  afterEach(() => {
    Object.assign(globalThis, {
      fetch: originalFetch,
      DecompressionStream: originalDecompressionStream,
    });
  });

  it("loads a gzipped idle GLB animation", async () => {
    const compressed = new Uint8Array([0x1f, 0x8b, 0x08, 0x00]).buffer;
    const decompressed = new ArrayBuffer(32);
    hoisted.fetchMock.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: vi.fn().mockResolvedValue(compressed),
    });

    class MockDecompressionStream {
      readable = new ReadableStream<Uint8Array>();
      writable = new WritableStream<Uint8Array>();
    }

    Object.assign(globalThis, {
      DecompressionStream:
        MockDecompressionStream as typeof DecompressionStream,
    });

    const pipeThroughSpy = vi.spyOn(Blob.prototype, "stream").mockReturnValue({
      pipeThrough: vi.fn(() => new ReadableStream<Uint8Array>()),
    } as ReturnType<Blob["stream"]>);
    const responseArrayBufferSpy = vi
      .spyOn(Response.prototype, "arrayBuffer")
      .mockResolvedValueOnce(decompressed);

    const vrm = {
      scene: { updateMatrixWorld: vi.fn() },
    } as VRM;
    const gltf = {
      scene: { updateMatrixWorld: vi.fn() },
      animations: [],
    };
    const clip = { name: "idle" };
    hoisted.gltfParseAsyncMock.mockResolvedValueOnce(gltf);
    hoisted.retargetGltfMock.mockReturnValueOnce(clip);

    const result = await loadIdleClip(vrm, "/animations/idle.glb.gz", {
      isAborted: () => false,
      isCurrentVrm: () => true,
    });

    expect(result).toBe(clip);
    expect(hoisted.fetchMock).toHaveBeenCalledWith("/animations/idle.glb.gz");
    expect(hoisted.gltfParseAsyncMock).toHaveBeenCalledWith(
      decompressed,
      "/animations/",
    );
    expect(hoisted.retargetGltfMock).toHaveBeenCalledWith(gltf, vrm);

    responseArrayBufferSpy.mockRestore();
    pipeThroughSpy.mockRestore();
  });

  it("loads a gzipped Mixamo FBX emote", async () => {
    const compressed = new Uint8Array([0x1f, 0x8b, 0x08, 0x00]).buffer;
    const decompressed = new ArrayBuffer(64);
    hoisted.fetchMock.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: vi.fn().mockResolvedValue(compressed),
    });

    class MockDecompressionStream {
      readable = new ReadableStream<Uint8Array>();
      writable = new WritableStream<Uint8Array>();
    }

    Object.assign(globalThis, {
      DecompressionStream:
        MockDecompressionStream as typeof DecompressionStream,
    });

    const pipeThroughSpy = vi.spyOn(Blob.prototype, "stream").mockReturnValue({
      pipeThrough: vi.fn(() => new ReadableStream<Uint8Array>()),
    } as ReturnType<Blob["stream"]>);
    const responseArrayBufferSpy = vi
      .spyOn(Response.prototype, "arrayBuffer")
      .mockResolvedValueOnce(decompressed);

    const vrm = {
      scene: { updateMatrixWorld: vi.fn() },
    } as VRM;
    const sourceClip = { name: "happy" };
    const fbx = {
      animations: [sourceClip],
    };
    const clip = { name: "happy" };
    hoisted.fbxParseMock.mockReturnValueOnce(fbx);
    hoisted.retargetFbxMock.mockReturnValueOnce(clip);

    const result = await loadEmoteClip("/animations/mixamo/Happy.fbx.gz", vrm, {
      isAborted: () => false,
      isCurrentVrm: () => true,
    });

    expect(result).toBe(clip);
    expect(hoisted.fetchMock).toHaveBeenCalledWith(
      "/animations/mixamo/Happy.fbx.gz",
    );
    expect(hoisted.fbxParseMock).toHaveBeenCalledWith(
      decompressed,
      "/animations/mixamo/",
    );
    expect(hoisted.retargetFbxMock).toHaveBeenCalledWith(fbx, sourceClip, vrm);

    responseArrayBufferSpy.mockRestore();
    pipeThroughSpy.mockRestore();
  });
});

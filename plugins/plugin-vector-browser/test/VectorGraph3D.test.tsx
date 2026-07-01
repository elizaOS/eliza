// @vitest-environment jsdom

/**
 * Behavioral coverage for the exported 3D projection sub-component
 * (VectorGraph3D from src/VectorBrowserView.tsx).
 *
 * three.js is real WebGL — there is no GL context in jsdom — so the component
 * exposes a `createRenderer` prop seam (default:
 * getBootConfig().companionVectorBrowser.createVectorBrowserRenderer). These
 * tests drive that seam directly:
 *   (a) <2 embedded memories -> the "Not enough embeddings" empty state;
 *   (b) >=2 real (dim_768) embeddings + a fake WebGLRenderer (canvas domElement,
 *       noop setSize/setPixelRatio/render/dispose) -> the populated projection
 *       header + a per-type color legend + a mounted canvas;
 *   (c) createRenderer rejects -> the "Renderer unavailable" fallback.
 *
 * The THREE namespace is supplied via getBootConfig().companionVectorBrowser as
 * a minimal stub covering exactly the API the scene-setup path constructs
 * (Scene/Color/PerspectiveCamera/Raycaster/Vector2/SphereGeometry/
 * MeshBasicMaterial/Mesh/GridHelper/BufferGeometry/BufferAttribute/
 * LineBasicMaterial/LineSegments). The PCA projection itself runs for real via
 * the un-mocked vector-browser-utils.
 */

import {
  type MemoryRecord,
  rowToMemory,
} from "@elizaos/ui/components/pages/vector-browser-utils";
import { afterEach, describe, expect, it, vi } from "vitest";

// ── Minimal THREE stub: only what the scene-setup path constructs ───────────
const threeStub = vi.hoisted(() => {
  class Color {
    getHex() {
      return 0x333333;
    }
  }
  class Vector2 {
    set() {}
  }
  class Vector3 {
    setScalar() {}
  }
  class Scene {
    background: unknown = null;
    add() {}
  }
  class PerspectiveCamera {
    aspect = 1;
    position = { set: () => {}, x: 0, y: 0, z: 0 };
    lookAt() {}
    updateProjectionMatrix() {}
  }
  class Raycaster {
    setFromCamera() {}
    intersectObjects() {
      return [] as unknown[];
    }
  }
  class SphereGeometry {
    dispose() {}
  }
  class MeshBasicMaterial {
    opacity = 1;
    dispose() {}
  }
  class Mesh {
    material: unknown;
    userData: Record<string, unknown> = {};
    position = { set: () => {} };
    scale = new Vector3();
    constructor(_g: unknown, m: unknown) {
      this.material = m;
    }
  }
  class GridHelper {
    position = { y: 0 };
    material: { dispose: () => void } = { dispose: () => {} };
    geometry = { dispose: () => {} };
  }
  class BufferGeometry {
    setAttribute() {}
    dispose() {}
  }
  class BufferAttribute {}
  class LineBasicMaterial {
    dispose() {}
  }
  class LineSegments {}
  return {
    Color,
    Vector2,
    Vector3,
    Scene,
    PerspectiveCamera,
    Raycaster,
    SphereGeometry,
    MeshBasicMaterial,
    Mesh,
    GridHelper,
    BufferGeometry,
    BufferAttribute,
    LineBasicMaterial,
    LineSegments,
  };
});

function translate(key: string, vars?: Record<string, unknown>): string {
  if (vars && typeof vars.defaultValue === "string") return vars.defaultValue;
  return key;
}

type MockAppState = {
  t: typeof translate;
};

vi.mock("@elizaos/ui/state", () => {
  const state: MockAppState = { t: translate };
  return {
    useApp: () => state,
    useAppSelector: <T,>(selector: (state: MockAppState) => T) =>
      selector(state),
  };
});

vi.mock("@elizaos/ui/config", () => ({
  getBootConfig: () => ({
    companionVectorBrowser: {
      THREE: threeStub,
      createVectorBrowserRenderer: async () => {
        throw new Error("default renderer unavailable");
      },
    },
  }),
}));

// The remaining @elizaos/ui glue subpaths are pulled in transitively by the
// view module; supply thin stand-ins so the module evaluates.
vi.mock("@elizaos/ui/agent-surface", () => ({
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
}));
vi.mock("@elizaos/ui/api", () => ({ client: {} }));
vi.mock("@elizaos/ui/hooks", () => ({ useRenderGuard: () => {} }));
vi.mock("@elizaos/ui/layouts", () => ({
  WorkspaceLayout: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock("@elizaos/ui/components/composites/page-panel", () => ({
  PagePanel: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock("@elizaos/ui/components/ui/skeleton-layouts", () => ({
  ListSkeleton: () => <div />,
}));
vi.mock("@elizaos/ui/components/ui/button", () => ({
  Button: ({ children }: { children?: React.ReactNode }) => (
    <button type="button">{children}</button>
  ),
}));
vi.mock("@elizaos/ui/components/ui/input", () => ({ Input: () => <input /> }));
vi.mock("@elizaos/ui/components/ui/select", () => ({
  Select: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SelectContent: ({ children }: { children?: React.ReactNode }) => (
    <>{children}</>
  ),
  SelectItem: () => null,
  SelectTrigger: () => null,
  SelectValue: () => null,
}));
vi.mock("@elizaos/ui/components/pages/MemoryDetailPanel", () => ({
  MemoryDetailPanel: () => <div data-testid="detail" />,
}));

const { render, screen, cleanup, waitFor } = await import(
  "@testing-library/react"
);
const { VectorGraph3D } = await import("../src/VectorBrowserView.tsx");

// ── Fixtures: real-shaped memories with parseable dim_768 embeddings ────────
function embeddedMemory(id: string, type: string, seed: number): MemoryRecord {
  const parts: number[] = [];
  for (let i = 0; i < 768; i += 1) {
    parts.push(Number(((seed + 1) * 0.013 + i * 0.0007).toFixed(6)));
  }
  return rowToMemory({
    id,
    content: JSON.stringify({ text: `memory ${id}` }),
    type,
    room_id: "r",
    entity_id: "e",
    created_at: "2026-06-16T10:30:00.000Z",
    unique: true,
    dim_768: `[${parts.join(",")}]`,
  });
}

function bareMemory(id: string): MemoryRecord {
  return rowToMemory({
    id,
    content: "no vector",
    type: "message",
    room_id: "r",
    entity_id: "e",
    created_at: "2026-06-16T10:30:00.000Z",
    unique: false,
    dim_768: null,
  });
}

function fakeRenderer() {
  const canvas = document.createElement("canvas");
  return {
    domElement: canvas,
    setSize: vi.fn(),
    setPixelRatio: vi.fn(),
    render: vi.fn(),
    dispose: vi.fn(),
  };
}

afterEach(() => {
  cleanup();
});

describe("VectorGraph3D", () => {
  it("renders the empty state with fewer than 2 embedded memories", () => {
    render(
      <VectorGraph3D
        memories={[embeddedMemory("m-0", "fact", 0), bareMemory("m-1")]}
        onSelect={() => {}}
      />,
    );
    // only 1 memory has an embedding -> "Not enough embeddings" (bare i18n key)
    expect(
      screen.getByText("vectorbrowserview.NotEnoughEmbedding1"),
    ).toBeTruthy();
  });

  it("renders the populated projection header, canvas, and per-type color legend", async () => {
    const renderer = fakeRenderer();
    const createRenderer = vi.fn(async () => renderer as never);

    const { container } = render(
      <VectorGraph3D
        memories={[
          embeddedMemory("m-0", "fact", 0),
          embeddedMemory("m-1", "message", 1),
          embeddedMemory("m-2", "fact", 2),
        ]}
        onSelect={() => {}}
        createRenderer={createRenderer}
      />,
    );

    // header: "{N} {t('vectorbrowserview.vectorsProjectedTo1')}" -> bare key
    expect(
      screen.getByText(/vectorbrowserview\.vectorsProjectedTo1/),
    ).toBeTruthy();
    // NOT the empty state
    expect(
      screen.queryByText("vectorbrowserview.NotEnoughEmbedding1"),
    ).toBeNull();

    // the renderer seam was invoked and its canvas mounted into the container
    await waitFor(() => {
      expect(createRenderer).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(container.querySelector("canvas")).toBe(renderer.domElement);
    });

    // color legend: one entry per distinct type (fact, message)
    expect(screen.getByText("fact")).toBeTruthy();
    expect(screen.getByText("message")).toBeTruthy();
  });

  it("renders the 'Renderer unavailable' fallback when createRenderer rejects", async () => {
    const createRenderer = vi.fn(async () => {
      throw new Error("WebGL init failed");
    });

    render(
      <VectorGraph3D
        memories={[
          embeddedMemory("m-0", "fact", 0),
          embeddedMemory("m-1", "message", 1),
        ]}
        onSelect={() => {}}
        createRenderer={createRenderer}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Unavailable")).toBeTruthy();
    });
  });
});

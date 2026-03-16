/** @vitest-environment jsdom */

import { act, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  createVectorBrowserRendererMock,
  rendererDisposeMock,
  requestAnimationFrameMock,
  getDatabaseTablesMock,
  executeDatabaseQueryMock,
} = vi.hoisted(() => ({
  createVectorBrowserRendererMock: vi.fn(),
  rendererDisposeMock: vi.fn(),
  requestAnimationFrameMock: vi.fn(() => 1),
  getDatabaseTablesMock: vi.fn(),
  executeDatabaseQueryMock: vi.fn(),
}));

vi.mock("@elizaos/app-core/components/vector-browser-three", () => {
  class MockVector2 {
    x = 0;
    y = 0;

    set(x: number, y: number) {
      this.x = x;
      this.y = y;
      return this;
    }
  }

  class MockVector3 {
    x = 0;
    y = 0;
    z = 0;

    set(x: number, y: number, z: number) {
      this.x = x;
      this.y = y;
      this.z = z;
      return this;
    }
  }

  class MockColor {}

  class MockMaterial {
    opacity = 1;
    transparent = false;

    constructor(config?: { opacity?: number; transparent?: boolean }) {
      if (typeof config?.opacity === "number") {
        this.opacity = config.opacity;
      }
      if (typeof config?.transparent === "boolean") {
        this.transparent = config.transparent;
      }
    }

    dispose() {}
  }

  class MockGeometry {
    setAttribute() {}
    dispose() {}
  }

  class MockMesh {
    position = new MockVector3();
    scale = { setScalar: vi.fn() };
    userData: Record<string, unknown> = {};
    material: MockMaterial | MockMaterial[];
    geometry: MockGeometry;

    constructor(
      geometry: MockGeometry = new MockGeometry(),
      material: MockMaterial | MockMaterial[] = new MockMaterial(),
    ) {
      this.geometry = geometry;
      this.material = material;
    }
  }

  class MockGridHelper extends MockMesh {
    constructor() {
      super(new MockGeometry(), new MockMaterial());
    }
  }

  class MockScene {
    background: unknown = null;
    add() {}
    remove() {}
  }

  class MockCamera {
    position = new MockVector3();
    aspect = 1;

    lookAt() {}
    updateProjectionMatrix() {}
  }

  class MockRenderer {
    domElement = document.createElement("canvas");

    setSize() {}
    setPixelRatio() {}
    render() {}
    dispose() {
      rendererDisposeMock();
    }
  }

  class MockRaycaster {
    setFromCamera() {}
    intersectObjects() {
      return [];
    }
  }

  return {
    THREE: {
      Scene: MockScene,
      PerspectiveCamera: MockCamera,
      SphereGeometry: MockGeometry,
      BufferGeometry: MockGeometry,
      MeshBasicMaterial: MockMaterial,
      LineBasicMaterial: MockMaterial,
      Mesh: MockMesh,
      LineSegments: MockMesh,
      GridHelper: MockGridHelper,
      Vector2: MockVector2,
      Vector3: MockVector3,
      Color: MockColor,
      Raycaster: MockRaycaster,
      BufferAttribute: class {},
    },
    createVectorBrowserRenderer:
      createVectorBrowserRendererMock.mockImplementation(
        async () => new MockRenderer(),
      ),
  };
});

vi.mock("@elizaos/app-core/api", () => ({
  client: {
    getDatabaseTables: getDatabaseTablesMock,
    executeDatabaseQuery: executeDatabaseQueryMock,
  },
}));

import { client } from "@elizaos/app-core/api";
import { VectorBrowserView } from "@elizaos/app-core/components/VectorBrowserView";

async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

describe("VectorBrowserView async cleanup", () => {
  let host: HTMLDivElement;
  let root: Root;
  let originalAppendChild: typeof HTMLDivElement.prototype.appendChild;
  let clientWidthDescriptor: PropertyDescriptor | undefined;
  let devicePixelRatioDescriptor: PropertyDescriptor | undefined;
  let gpuDescriptor: PropertyDescriptor | undefined;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    rendererDisposeMock.mockReset();
    createVectorBrowserRendererMock.mockClear();
    requestAnimationFrameMock.mockClear();
    vi.mocked(client.getDatabaseTables).mockReset();
    vi.mocked(client.executeDatabaseQuery).mockReset();

    clientWidthDescriptor = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "clientWidth",
    );
    devicePixelRatioDescriptor = Object.getOwnPropertyDescriptor(
      window,
      "devicePixelRatio",
    );
    gpuDescriptor = Object.getOwnPropertyDescriptor(navigator, "gpu");

    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get() {
        return 800;
      },
    });
    Object.defineProperty(window, "devicePixelRatio", {
      configurable: true,
      value: 1,
    });
    Object.defineProperty(navigator, "gpu", {
      configurable: true,
      value: {},
    });

    vi.stubGlobal("requestAnimationFrame", requestAnimationFrameMock);
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    originalAppendChild = HTMLDivElement.prototype.appendChild;

    vi.mocked(client.getDatabaseTables).mockResolvedValue({
      tables: [
        { name: "memories", schema: "public", rowCount: 3, columns: [] },
        { name: "embeddings", schema: "public", rowCount: 3, columns: [] },
      ],
    });

    const rows = [
      {
        id: "1",
        content: "alpha memory",
        type: "message",
        created_at: "2026-03-07T00:00:00.000Z",
        dim_384: "[0.1,0.2,0.3]",
      },
      {
        id: "2",
        content: "beta memory",
        type: "message",
        created_at: "2026-03-07T00:01:00.000Z",
        dim_384: "[0.2,0.3,0.4]",
      },
      {
        id: "3",
        content: "gamma memory",
        type: "message",
        created_at: "2026-03-07T00:02:00.000Z",
        dim_384: "[0.3,0.4,0.5]",
      },
    ];

    vi.mocked(client.executeDatabaseQuery).mockImplementation(
      async (sql: string) => {
        if (sql.includes("information_schema.columns")) {
          return {
            columns: ["column_name", "data_type"],
            rows: [],
            rowCount: 0,
            durationMs: 1,
          };
        }
        if (sql.includes('WHERE "unique" = true')) {
          return {
            columns: ["cnt"],
            rows: [{ cnt: 0 }],
            rowCount: 1,
            durationMs: 1,
          };
        }
        if (sql.includes("COUNT(*) as cnt")) {
          return {
            columns: ["cnt"],
            rows: [{ cnt: rows.length }],
            rowCount: 1,
            durationMs: 1,
          };
        }
        return {
          columns: ["id", "content", "type", "created_at", "dim_384"],
          rows,
          rowCount: rows.length,
          durationMs: 1,
        };
      },
    );
  });

  afterEach(() => {
    HTMLDivElement.prototype.appendChild = originalAppendChild;
    try {
      root.unmount();
    } catch {}
    host.remove();

    if (clientWidthDescriptor) {
      Object.defineProperty(
        HTMLElement.prototype,
        "clientWidth",
        clientWidthDescriptor,
      );
    }
    if (devicePixelRatioDescriptor) {
      Object.defineProperty(
        window,
        "devicePixelRatio",
        devicePixelRatioDescriptor,
      );
    } else {
      Reflect.deleteProperty(window, "devicePixelRatio");
    }
    if (gpuDescriptor) {
      Object.defineProperty(navigator, "gpu", gpuDescriptor);
    } else {
      Reflect.deleteProperty(navigator, "gpu");
    }

    vi.unstubAllGlobals();
    consoleErrorSpy.mockRestore();
    vi.clearAllMocks();
  });

  it("disposes the renderer if the component unmounts during canvas attach", async () => {
    let unmountedDuringAppend = false;
    let hideGraph: (() => void) | null = null;

    function Harness() {
      const [visible, setVisible] = useState(true);
      hideGraph = () => setVisible(false);
      return visible ? <VectorBrowserView /> : null;
    }

    HTMLDivElement.prototype.appendChild = function appendChildWithUnmount(
      child: Node,
    ) {
      const result = originalAppendChild.call(this, child);
      if (
        !unmountedDuringAppend &&
        this.style.height === "550px" &&
        child instanceof HTMLCanvasElement
      ) {
        unmountedDuringAppend = true;
        flushSync(() => {
          hideGraph?.();
        });
      }
      return result;
    };

    await act(async () => {
      root.render(<Harness />);
    });
    await flush();

    const threeDButton = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "3D",
    );
    expect(threeDButton).toBeTruthy();

    await act(async () => {
      threeDButton?.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
        }),
      );
    });
    await flush();

    expect(unmountedDuringAppend).toBe(true);
    expect(createVectorBrowserRendererMock).toHaveBeenCalledTimes(1);
    expect(rendererDisposeMock).toHaveBeenCalledTimes(1);
  });
});

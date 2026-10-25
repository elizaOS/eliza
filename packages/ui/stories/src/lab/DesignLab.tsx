/**
 * The Design Lab shell: a fast, app-free workspace for iterating on the
 * full-viewport product surfaces (chat, onboarding, home widgets) with real
 * @elizaos/ui components and mocked data. Three columns — a surface picker, a
 * device-framed stage, and a per-surface control panel. The stage frame sets a
 * `transform`/`contain` containing block so each surface's `position: fixed`
 * chrome is scoped to the phone/tablet/desktop frame instead of the whole page,
 * and a viewport reset (`--safe-area-*` = 0) keeps the mocked device honest.
 *
 * State (surface + device) is mirrored to the URL hash so a reload — or a shared
 * link — lands back on the same setup, the whole point of not booting the app.
 */
import * as React from "react";

// Surfaces are code-split so switching one in never loads another's graph: the
// home/widgets tree pulls a much heavier dependency graph (plugin registry,
// notifications, agent catalog) than chat, so eager-importing all three would
// make the whole lab wait on the slowest one — and one surface's missing shim
// symbol would blank the entire lab. Lazy per-surface isolates both.
const ChatLab = React.lazy(() =>
  import("./surfaces/ChatLab").then((m) => ({ default: m.ChatLab })),
);
const WidgetsLab = React.lazy(() =>
  import("./surfaces/WidgetsLab").then((m) => ({ default: m.WidgetsLab })),
);

interface LabSurface {
  id: string;
  name: string;
  blurb: string;
  render: (controlsEl: HTMLElement | null) => React.ReactNode;
}

const SURFACES: LabSurface[] = [
  {
    id: "chat",
    name: "Chat",
    blurb: "The floating pull-up sheet — pill → input → sheet → maximize.",
    render: (el) => <ChatLab controlsEl={el} />,
  },
  {
    id: "onboarding",
    name: "Onboarding",
    blurb: "First-run: pinned full-screen greeting, then the reveal.",
    render: (el) => <ChatLab controlsEl={el} onboarding />,
  },
  {
    id: "widgets",
    name: "Home widgets",
    blurb: "The home dashboard — widget host, notifications, launcher.",
    render: (el) => <WidgetsLab controlsEl={el} />,
  },
];

type DeviceKind = "phone" | "tablet" | "desktop";

const DEVICES: Record<
  DeviceKind,
  { label: string; width: number; height: number }
> = {
  phone: { label: "Phone", width: 390, height: 844 },
  tablet: { label: "Tablet", width: 834, height: 1112 },
  desktop: { label: "Desktop", width: 1280, height: 832 },
};

function readHash(): { surface: string; device: DeviceKind } {
  const raw = typeof location !== "undefined" ? location.hash.slice(1) : "";
  const params = new URLSearchParams(raw);
  const surface = params.get("surface") ?? SURFACES[0].id;
  const device = (params.get("device") as DeviceKind) ?? "phone";
  return {
    surface: SURFACES.some((s) => s.id === surface) ? surface : SURFACES[0].id,
    device: device in DEVICES ? device : "phone",
  };
}

export function DesignLab() {
  const initial = readHash();
  const [surfaceId, setSurfaceId] = React.useState(initial.surface);
  const [device, setDevice] = React.useState<DeviceKind>(initial.device);
  const [controlsEl, setControlsEl] = React.useState<HTMLElement | null>(null);

  React.useEffect(() => {
    const params = new URLSearchParams();
    params.set("surface", surfaceId);
    params.set("device", device);
    const next = `#${params.toString()}`;
    if (location.hash !== next) history.replaceState(null, "", next);
  }, [surfaceId, device]);

  const surface = SURFACES.find((s) => s.id === surfaceId) ?? SURFACES[0];
  const frame = DEVICES[device];
  const fill = device === "desktop";

  return (
    <div className="lab">
      <aside className="lab-sidebar">
        <div className="lab-brand">
          <span className="lab-brand-dot" />
          Design Lab
        </div>
        <div className="lab-sidebar-hint">real components · mocked data</div>
        <nav className="lab-nav" aria-label="Surfaces">
          {SURFACES.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`lab-nav-item ${s.id === surfaceId ? "is-active" : ""}`}
              onClick={() => setSurfaceId(s.id)}
            >
              <span className="lab-nav-name">{s.name}</span>
              <span className="lab-nav-blurb">{s.blurb}</span>
            </button>
          ))}
        </nav>
        <div className="lab-sidebar-foot">
          <div className="lab-sidebar-foot-label">Device</div>
          <div className="lab-device-picker">
            {(Object.keys(DEVICES) as DeviceKind[]).map((d) => (
              <button
                key={d}
                type="button"
                className={`lab-device ${d === device ? "is-active" : ""}`}
                onClick={() => setDevice(d)}
              >
                {DEVICES[d].label}
              </button>
            ))}
          </div>
        </div>
      </aside>

      <main className="lab-stage">
        <div
          className={`lab-device-frame ${fill ? "is-fill" : ""}`}
          // The transform establishes a containing block so the surface's
          // `position: fixed` chrome is scoped to this frame, not the window.
          style={
            fill ? undefined : { width: frame.width, height: frame.height }
          }
        >
          {/* Keying on surface id remounts on switch — each surface owns its
              own fixed-overlay lifecycle and window listeners. */}
          <div className="lab-viewport" key={surface.id}>
            <React.Suspense
              fallback={
                <div className="lab-loading">Loading {surface.name}…</div>
              }
            >
              {surface.render(controlsEl)}
            </React.Suspense>
          </div>
        </div>
      </main>

      <aside className="lab-controls-col">
        <div className="lab-controls-head">
          <div className="lab-controls-title">{surface.name}</div>
          <div className="lab-controls-sub">{surface.blurb}</div>
        </div>
        <div className="lab-controls" ref={setControlsEl} />
      </aside>
    </div>
  );
}

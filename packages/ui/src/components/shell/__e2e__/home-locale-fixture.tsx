/**
 * Render fixture for the locale-correctness of the two doctrine home widgets —
 * time + weather (#14345). Mounts the REAL `DefaultHomeWidgets` on the orange
 * home field. Locale + a fixed clock are injected by the runner (playwright
 * context locale + `clock.install`); geolocation + the Open-Meteo fetch are
 * stubbed so weather resolves to a real "ready" reading whose unit follows the
 * locale. The `../../state` app selector is stubbed by the runner (its real
 * graph pulls Node-only deps) to keep the time tile shown.
 */
import { createRoot } from "react-dom/client";
import { DefaultHomeWidgets } from "../DefaultHomeWidgets";

createRoot(document.getElementById("root") as HTMLElement).render(
  <div style={{ background: "#e8590c", minHeight: "100vh", padding: 28 }}>
    <div style={{ maxWidth: 520 }}>
      <DefaultHomeWidgets />
    </div>
  </div>,
);

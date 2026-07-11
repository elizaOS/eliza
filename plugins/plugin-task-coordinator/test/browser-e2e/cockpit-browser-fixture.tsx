/** Mounts the production cockpit route as a full-height browser proof surface. */
import { createRoot } from "react-dom/client";
import { CockpitRoute } from "../../src/CockpitRoute";

const root = document.getElementById("root");
if (!root) throw new Error("Cockpit browser fixture root is missing");
createRoot(root).render(<CockpitRoute />);

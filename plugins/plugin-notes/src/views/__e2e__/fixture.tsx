import "@elizaos/ui/styles";
import { AgentSurfaceProvider } from "@elizaos/ui/agent-surface";
import { ApiError } from "@elizaos/ui/api/client-types-core";
import { createRoot } from "react-dom/client";
import type { NotesSnapshot, StickyNote } from "../../types.js";
import { NotesSurface } from "../NotesSurface.js";
import "./fixture.css";

type FixtureState =
  | "populated"
  | "empty"
  | "loading"
  | "offline"
  | "stale"
  | "dedicated";

const params = new URLSearchParams(window.location.search);
const fixtureState = (params.get("state") ?? "populated") as FixtureState;
const theme = params.get("theme") === "light" ? "light" : "dark";
document.documentElement.dataset.theme = theme;
document.documentElement.classList.toggle("dark", theme === "dark");

const notes: StickyNote[] = [
  {
    id: "note-demo-1",
    title: "Demo run of show",
    body: "Open on the launcher, ask Eliza for the day, then show Notes and Calendar.",
    color: "yellow",
    createdAt: "2026-08-25T17:30:00.000Z",
    updatedAt: "2026-08-26T04:42:00.000Z",
  },
  {
    id: "note-demo-2",
    title: "Pixel checklist",
    body: "Charge the phone\nEnable Wi-Fi\nKeep a USB-C cable nearby",
    color: "green",
    createdAt: "2026-08-25T18:10:00.000Z",
    updatedAt: "2026-08-26T03:18:00.000Z",
  },
  {
    id: "note-demo-3",
    title: "Follow up",
    body: "Send the staging build notes after the demo.",
    color: "slate",
    createdAt: "2026-08-25T19:00:00.000Z",
    updatedAt: "2026-08-25T21:12:00.000Z",
  },
];

const populatedSnapshot: NotesSnapshot = { notes, revision: 3 };
const emptySnapshot: NotesSnapshot = { notes: [], revision: 0 };

function dedicatedError(): ApiError {
  const data = {
    success: false,
    code: "notes_runtime_unavailable",
    retryable: false,
  };
  return new ApiError({
    kind: "http",
    path: "/api/notes/state",
    status: 503,
    code: data.code,
    message: "Notes require a Dedicated agent.",
    data,
  });
}

function stateProps(): {
  snapshot: NotesSnapshot | null;
  loading: boolean;
  error: Error | null;
} {
  switch (fixtureState) {
    case "empty":
      return { snapshot: emptySnapshot, loading: false, error: null };
    case "loading":
      return { snapshot: null, loading: true, error: null };
    case "offline":
      return {
        snapshot: null,
        loading: false,
        error: new TypeError("Failed to fetch"),
      };
    case "stale":
      return {
        snapshot: populatedSnapshot,
        loading: false,
        error: new TypeError("Failed to fetch"),
      };
    case "dedicated":
      return {
        snapshot: null,
        loading: false,
        error: dedicatedError(),
      };
    default:
      return { snapshot: populatedSnapshot, loading: false, error: null };
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("Notes fixture root is missing.");

createRoot(root).render(
  <AgentSurfaceProvider viewId="notes-fixture">
    <NotesSurface
      {...stateProps()}
      refresh={async () => undefined}
      standalone
    />
  </AgentSurfaceProvider>,
);

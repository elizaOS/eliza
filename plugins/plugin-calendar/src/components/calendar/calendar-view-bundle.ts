// Vite view-bundle entry. Re-exports the CalendarView component so the built
// bundle (dist/views/bundle.js) exposes the named export the view loader reads.
// Kept separate from CalendarView.tsx so that file exports only React
// components and stays Fast-Refresh-compatible in dev.
export { CalendarView } from "./CalendarView.tsx";

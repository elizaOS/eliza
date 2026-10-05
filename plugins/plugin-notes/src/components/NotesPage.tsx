/**
 * Mounts the Notes route body beneath navigation chrome owned by the app shell.
 * Keeping the bundle body-only prevents remote and signed renderers from
 * producing a second title and back affordance around the same collection.
 */

import type { JSX } from "react";
import { NotesView } from "./NotesView.js";

export function NotesPage(): JSX.Element {
  return <NotesView />;
}

/**
 * AppWindowRenderer — full-bleed renderer for `appWindow=1#/apps/<slug>` routes.
 *
 * Each Electrobun app window mounts exactly one of:
 *   1. an internal-tool tab component (plugins, skills, lifeops, …)
 *   2. a registered overlay app's Component (e.g. companion)
 *   3. a registry/catalog app viewer iframe (with postMessage auth handshake)
 *
 * The renderer never mounts the main shell (sidebars, header, chat panes).
 */
import { type JSX } from "react";

interface AppWindowRendererProps {
  slug: string;
}
export declare function AppWindowRenderer({
  slug,
}: AppWindowRendererProps): JSX.Element;
//# sourceMappingURL=AppWindowRenderer.d.ts.map

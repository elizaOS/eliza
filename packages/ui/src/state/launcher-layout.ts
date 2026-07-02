/**
 * Launcher layout constants.
 *
 * The launcher is a read-only curated springboard (page composition +
 * visibility are owned by `curateLauncherPages`), so there is no persisted
 * free-form layout, reorder, or edit mode — only these two shared sizing
 * constants survive.
 */

/**
 * Icons per launcher page. The Launcher grid is responsive — `grid-cols-4`
 * (portrait/mobile) and `sm:grid-cols-5` at ≥sm — and is `overflow-y-auto`, so a
 * page longer than the visible rows scrolls rather than clipping. The launcher
 * renders a single curated page, so this is a soft reference value (e.g. for
 * fixtures) rather than a hard pagination cap.
 */
export const LAUNCHER_PAGE_SIZE = 24;

/**
 * Pin cap for the desktop-tab pinning model (`useDesktopTabs`): at most this
 * many pinned tabs, iOS-dock style.
 */
export const LAUNCHER_DOCK_LIMIT = 4;

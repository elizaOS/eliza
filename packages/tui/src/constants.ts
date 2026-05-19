/**
 * TUI Constants
 *
 * Centralized constants for the TUI package.
 * These replace magic numbers scattered throughout the codebase.
 */

// =========================================================================
// TIMING CONSTANTS
// =========================================================================

/** Stdin buffer timeout in milliseconds - time to wait for incomplete sequences */
export const STDIN_BUFFER_TIMEOUT_MS = 10;

/** Loader animation frame interval in milliseconds */
export const LOADER_ANIMATION_INTERVAL_MS = 80;

/** Maximum time to wait when draining input in milliseconds */
export const DRAIN_INPUT_MAX_MS = 1000;

/** Idle time threshold for input draining in milliseconds */
export const DRAIN_INPUT_IDLE_MS = 50;

// =========================================================================
// TERMINAL DIMENSIONS
// =========================================================================

/** Default terminal width when not detected */
export const DEFAULT_TERMINAL_WIDTH = 80;

/** Default terminal height when not detected */
export const DEFAULT_TERMINAL_HEIGHT = 24;

/** Default terminal cell width in pixels */
export const DEFAULT_CELL_WIDTH_PX = 9;

/** Default terminal cell height in pixels */
export const DEFAULT_CELL_HEIGHT_PX = 18;

// =========================================================================
// EDITOR CONSTANTS
// =========================================================================

/** Maximum number of entries in command history */
export const DEFAULT_HISTORY_LIMIT = 100;

/** Character count threshold for "large paste" detection */
export const LARGE_PASTE_CHAR_THRESHOLD = 1000;

/** Line count threshold for "large paste" detection */
export const LARGE_PASTE_LINE_THRESHOLD = 10;

// =========================================================================
// AUTOCOMPLETE CONSTANTS
// =========================================================================

/** Maximum percentage of terminal height for autocomplete dropdown (0.3 = 30%) */
export const AUTOCOMPLETE_MAX_VISIBLE_PERCENT = 0.3;

/** Minimum number of visible autocomplete lines */
export const AUTOCOMPLETE_MIN_VISIBLE_LINES = 5;

/** Minimum bound for autocomplete dropdown size */
export const AUTOCOMPLETE_MIN_VISIBLE = 3;

/** Maximum bound for autocomplete dropdown size */
export const AUTOCOMPLETE_MAX_VISIBLE = 20;

/** Default number of visible autocomplete items */
export const DEFAULT_AUTOCOMPLETE_MAX_VISIBLE = 5;

/** Maximum number of directory entries to search for autocomplete */
export const AUTOCOMPLETE_SEARCH_LIMIT = 100;

/** Maximum number of autocomplete results to show */
export const AUTOCOMPLETE_RESULTS_LIMIT = 20;

/** Maximum buffer size for spawnSync in autocomplete (10 MB) */
export const AUTOCOMPLETE_MAX_BUFFER_BYTES = 10 * 1024 * 1024;

// =========================================================================
// AUTOCOMPLETE SCORING
// =========================================================================

/** Score for exact filename match */
export const SCORE_EXACT_MATCH = 100;

/** Score for filename that starts with query */
export const SCORE_STARTS_WITH = 80;

/** Score for filename that contains query */
export const SCORE_CONTAINS = 50;

/** Score for path that contains query */
export const SCORE_PATH_CONTAINS = 30;

/** Bonus score for directory entries */
export const SCORE_DIRECTORY_BONUS = 10;

// =========================================================================
// FUZZY SEARCH CONSTANTS
// =========================================================================

/** Score penalty for non-word-boundary matches in fuzzy search */
export const FUZZY_WORD_BOUNDARY_PENALTY = 10;

// =========================================================================
// UI LAYOUT CONSTANTS
// =========================================================================

/** Maximum width for unbroken words in table rendering */
export const MAX_UNBROKEN_WORD_WIDTH = 30;

/** Maximum width for labels in select/settings lists */
export const MAX_LIST_ITEM_LABEL_WIDTH = 30;

/** Fixed spacing width between value and description in select list */
export const SELECT_LIST_VALUE_SPACING_WIDTH = 32;

/** Minimum width before showing descriptions in lists */
export const MIN_WIDTH_FOR_DESCRIPTION = 40;

/** Minimum remaining width to display description */
export const MIN_REMAINING_WIDTH_FOR_DESCRIPTION = 10;

// =========================================================================
// IMAGE CONSTANTS
// =========================================================================

/** Default maximum image width in terminal cells */
export const DEFAULT_MAX_IMAGE_WIDTH_CELLS = 60;

/** Default image width in pixels when not detected */
export const DEFAULT_IMAGE_WIDTH_PX = 800;

/** Default image height in pixels when not detected */
export const DEFAULT_IMAGE_HEIGHT_PX = 600;

/** Chunk size when transmitting images via terminal */
export const IMAGE_CHUNK_SIZE = 4096;

/** iTerm2 image format parameter code */
export const ITERM2_IMAGE_FORMAT = 100;

/** Quality parameter for terminal image display */
export const IMAGE_QUALITY_PARAM = 2;

/** Minimum buffer size for PNG header */
export const PNG_HEADER_SIZE = 24;

/** Minimum buffer size for GIF header */
export const GIF_HEADER_SIZE = 10;

/** Minimum buffer size for WEBP format */
export const WEBP_MIN_SIZE = 25;

/** Buffer size for WEBP extended format */
export const WEBP_EXTENDED_SIZE = 30;

// =========================================================================
// CHARACTER CODE CONSTANTS
// =========================================================================

/** Minimum printable character code (SPACE) */
export const MIN_PRINTABLE_CHAR_CODE = 32;

/** DEL/Backspace character code */
export const CHAR_CODE_DEL = 0x7f;

/** Start of extended control character range (C1) */
export const CONTROL_CHAR_RANGE_START = 0x80;

/** End of extended control character range (C1) */
export const CONTROL_CHAR_RANGE_END = 0x9f;

// =========================================================================
// CACHE CONSTANTS
// =========================================================================

/** Maximum entries in the visible width calculation cache */
export const WIDTH_CACHE_SIZE = 512;

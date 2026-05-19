// Core TUI interfaces and classes

// Type definitions
export type { ListItemToken, ListToken, TableCellToken, TableToken } from "./types/marked-tokens.js";

// Autocomplete support
export {
	type AutocompleteItem,
	type AutocompleteProvider,
	CombinedAutocompleteProvider,
	type SlashCommand,
} from "./autocomplete.js";
// Components
export { Box } from "./components/box.js";
export { CancellableLoader } from "./components/cancellable-loader.js";
export { Editor, type EditorOptions, type EditorTheme } from "./components/editor.js";
export { Image, type ImageOptions, type ImageTheme } from "./components/image.js";
export { Input } from "./components/input.js";
export { Loader } from "./components/loader.js";
export { type DefaultTextStyle, Markdown, type MarkdownTheme } from "./components/markdown.js";
export { type SelectItem, SelectList, type SelectListTheme } from "./components/select-list.js";
export { type SettingItem, SettingsList, type SettingsListTheme } from "./components/settings-list.js";
export { Spacer } from "./components/spacer.js";
export { Text } from "./components/text.js";
export { Toast, type ToastOptions, type ToastTheme, type ToastType } from "./components/toast.js";
export { TruncatedText } from "./components/truncated-text.js";
export { ProgressBar, type ProgressBarOptions, type ProgressBarTheme } from "./components/progress-bar.js";
// Editor component interface (for custom editors)
export type { EditorComponent } from "./editor-component.js";
// Fuzzy matching
export { type FuzzyMatch, fuzzyFilter, fuzzyMatch } from "./fuzzy.js";
// Keybindings
export {
	DEFAULT_EDITOR_KEYBINDINGS,
	type EditorAction,
	type EditorKeybindingsConfig,
	EditorKeybindingsManager,
	getEditorKeybindings,
	setEditorKeybindings,
} from "./keybindings.js";
// Keyboard input handling
export {
	isKeyRelease,
	isKeyRepeat,
	isKittyProtocolActive,
	Key,
	type KeyEventType,
	type KeyId,
	matchesKey,
	parseKey,
	setKittyProtocolActive,
} from "./keys.js";
// Input buffering for batch splitting
export { StdinBuffer, type StdinBufferEventMap, type StdinBufferOptions } from "./stdin-buffer.js";
// Terminal interface and implementations
export { ProcessTerminal, type Terminal } from "./terminal.js";
// Terminal image support
export {
	allocateImageId,
	type CellDimensions,
	calculateImageRows,
	deleteAllKittyImages,
	deleteKittyImage,
	detectCapabilities,
	encodeITerm2,
	encodeKitty,
	getCapabilities,
	getCellDimensions,
	getGifDimensions,
	getImageDimensions,
	getJpegDimensions,
	getPngDimensions,
	getWebpDimensions,
	type ImageDimensions,
	type ImageProtocol,
	type ImageRenderOptions,
	imageFallback,
	renderImage,
	resetCapabilitiesCache,
	setCellDimensions,
	type TerminalCapabilities,
} from "./terminal-image.js";
export {
	type Component,
	Container,
	CURSOR_MARKER,
	type Focusable,
	isFocusable,
	type OverlayAnchor,
	type OverlayHandle,
	type OverlayMargin,
	type OverlayOptions,
	type SizeValue,
	TUI,
} from "./tui.js";
// Utilities
export { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "./utils.js";

// Shared utility modules
export {
	cleanPasteForMultiLine,
	cleanPasteForSingleLine,
	type CursorPosition,
	deleteGraphemeBackward,
	deleteGraphemeForward,
	deleteToLineEnd,
	deleteToLineStart,
	deleteWordBackward,
	hasControlChars,
	insertTextAtCursor,
	isControlChar,
	moveCursorLeft,
	moveCursorRight,
	moveWordBackwards,
	moveWordForwards,
	PASTE_END,
	PasteHandler,
	type PasteHandlerResult,
	PASTE_START,
	type TextEditResult,
} from "./utils/index.js";

// Themes
export {
	ansi,
	compose,
	darkTheme,
	defaultTheme,
	getTheme,
	minimalTheme,
	oceanTheme,
	type Theme,
	type ThemeColors,
	themes,
} from "./themes/index.js";

// Constants
export {
	// Timing
	DRAIN_INPUT_IDLE_MS,
	DRAIN_INPUT_MAX_MS,
	LOADER_ANIMATION_INTERVAL_MS,
	STDIN_BUFFER_TIMEOUT_MS,
	// Terminal dimensions
	DEFAULT_CELL_HEIGHT_PX,
	DEFAULT_CELL_WIDTH_PX,
	DEFAULT_TERMINAL_HEIGHT,
	DEFAULT_TERMINAL_WIDTH,
	// Editor
	DEFAULT_HISTORY_LIMIT,
	LARGE_PASTE_CHAR_THRESHOLD,
	LARGE_PASTE_LINE_THRESHOLD,
	// Autocomplete
	AUTOCOMPLETE_MAX_BUFFER_BYTES,
	AUTOCOMPLETE_MAX_VISIBLE,
	AUTOCOMPLETE_MAX_VISIBLE_PERCENT,
	AUTOCOMPLETE_MIN_VISIBLE,
	AUTOCOMPLETE_MIN_VISIBLE_LINES,
	AUTOCOMPLETE_RESULTS_LIMIT,
	AUTOCOMPLETE_SEARCH_LIMIT,
	DEFAULT_AUTOCOMPLETE_MAX_VISIBLE,
	// Scoring
	SCORE_CONTAINS,
	SCORE_DIRECTORY_BONUS,
	SCORE_EXACT_MATCH,
	SCORE_PATH_CONTAINS,
	SCORE_STARTS_WITH,
	// Fuzzy search
	FUZZY_WORD_BOUNDARY_PENALTY,
	// UI Layout
	MAX_LIST_ITEM_LABEL_WIDTH,
	MAX_UNBROKEN_WORD_WIDTH,
	MIN_REMAINING_WIDTH_FOR_DESCRIPTION,
	MIN_WIDTH_FOR_DESCRIPTION,
	SELECT_LIST_VALUE_SPACING_WIDTH,
	// Image
	DEFAULT_IMAGE_HEIGHT_PX,
	DEFAULT_IMAGE_WIDTH_PX,
	DEFAULT_MAX_IMAGE_WIDTH_CELLS,
	GIF_HEADER_SIZE,
	IMAGE_CHUNK_SIZE,
	IMAGE_QUALITY_PARAM,
	ITERM2_IMAGE_FORMAT,
	PNG_HEADER_SIZE,
	WEBP_EXTENDED_SIZE,
	WEBP_MIN_SIZE,
	// Character codes
	CHAR_CODE_DEL,
	CONTROL_CHAR_RANGE_END,
	CONTROL_CHAR_RANGE_START,
	MIN_PRINTABLE_CHAR_CODE,
	// Cache
	WIDTH_CACHE_SIZE,
} from "./constants.js";

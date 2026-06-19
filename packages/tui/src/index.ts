// Core TUI interfaces and classes

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
export {
  Editor,
  type EditorOptions,
  type EditorTheme,
} from "./components/editor.js";
export {
  Image,
  type ImageOptions,
  type ImageTheme,
} from "./components/image.js";
export { Input } from "./components/input.js";
export { Loader } from "./components/loader.js";
export {
  type DefaultTextStyle,
  Markdown,
  type MarkdownTheme,
} from "./components/markdown.js";
export {
  ProgressBar,
  type ProgressBarOptions,
  type ProgressBarTheme,
} from "./components/progress-bar.js";
export {
  type SelectItem,
  SelectList,
  type SelectListTheme,
} from "./components/select-list.js";
export {
  type SettingItem,
  SettingsList,
  type SettingsListTheme,
} from "./components/settings-list.js";
export { Spacer } from "./components/spacer.js";
export { Text } from "./components/text.js";
export {
  Toast,
  type ToastOptions,
  type ToastTheme,
  type ToastType,
} from "./components/toast.js";
export { TruncatedText } from "./components/truncated-text.js";
// Constants
export {
  // Autocomplete
  AUTOCOMPLETE_MAX_BUFFER_BYTES,
  AUTOCOMPLETE_MAX_VISIBLE,
  AUTOCOMPLETE_MAX_VISIBLE_PERCENT,
  AUTOCOMPLETE_MIN_VISIBLE,
  AUTOCOMPLETE_MIN_VISIBLE_LINES,
  AUTOCOMPLETE_RESULTS_LIMIT,
  AUTOCOMPLETE_SEARCH_LIMIT,
  // Character codes
  CHAR_CODE_DEL,
  CONTROL_CHAR_RANGE_END,
  CONTROL_CHAR_RANGE_START,
  DEFAULT_AUTOCOMPLETE_MAX_VISIBLE,
  // Terminal dimensions
  DEFAULT_CELL_HEIGHT_PX,
  DEFAULT_CELL_WIDTH_PX,
  // Editor
  DEFAULT_HISTORY_LIMIT,
  // Image
  DEFAULT_IMAGE_HEIGHT_PX,
  DEFAULT_IMAGE_WIDTH_PX,
  DEFAULT_MAX_IMAGE_WIDTH_CELLS,
  DEFAULT_TERMINAL_HEIGHT,
  DEFAULT_TERMINAL_WIDTH,
  // Timing
  DRAIN_INPUT_IDLE_MS,
  DRAIN_INPUT_MAX_MS,
  // Fuzzy search
  FUZZY_WORD_BOUNDARY_PENALTY,
  GIF_HEADER_SIZE,
  IMAGE_CHUNK_SIZE,
  IMAGE_QUALITY_PARAM,
  ITERM2_IMAGE_FORMAT,
  LARGE_PASTE_CHAR_THRESHOLD,
  LARGE_PASTE_LINE_THRESHOLD,
  LOADER_ANIMATION_INTERVAL_MS,
  // UI Layout
  MAX_LIST_ITEM_LABEL_WIDTH,
  MAX_UNBROKEN_WORD_WIDTH,
  MIN_PRINTABLE_CHAR_CODE,
  MIN_REMAINING_WIDTH_FOR_DESCRIPTION,
  MIN_WIDTH_FOR_DESCRIPTION,
  PNG_HEADER_SIZE,
  // Scoring
  SCORE_CONTAINS,
  SCORE_DIRECTORY_BONUS,
  SCORE_EXACT_MATCH,
  SCORE_PATH_CONTAINS,
  SCORE_STARTS_WITH,
  SELECT_LIST_VALUE_SPACING_WIDTH,
  STDIN_BUFFER_TIMEOUT_MS,
  WEBP_EXTENDED_SIZE,
  WEBP_MIN_SIZE,
  // Cache
  WIDTH_CACHE_SIZE,
} from "./constants.js";
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
export {
  StdinBuffer,
  type StdinBufferEventMap,
  type StdinBufferOptions,
} from "./stdin-buffer.js";
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
// Type definitions
export type {
  ListItemToken,
  ListToken,
  TableCellToken,
  TableToken,
} from "./types/marked-tokens.js";
// Shared utility modules
export {
  type CursorPosition,
  cleanPasteForMultiLine,
  cleanPasteForSingleLine,
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
  PASTE_START,
  PasteHandler,
  type PasteHandlerResult,
  type TextEditResult,
} from "./utils/index.js";
// Utilities
export { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "./utils.js";
// Terminal view registry (host mounts plugin-registered views by id)
export {
  getTerminalView,
  hasTerminalView,
  listTerminalViewIds,
  registerTerminalView,
} from "./view-registry.js";

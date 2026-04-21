export const DEFAULT_SAFE_COMMANDS = [
  "screenshot",
  "browser_screenshot",
  "browser_state",
  "browser_info",
  "browser_get_dom",
  "browser_get_clickables",
  "browser_get_context",
  "browser_dom",
  "file_read",
  "file_exists",
  "directory_list",
  "file_list_downloads",
  "file_download",
  "terminal_read",
  "terminal_connect",
  "list_windows",
  "browser_list_tabs",
] as const;

export const DEFAULT_SAFE_COMMAND_SET: ReadonlySet<string> = new Set(DEFAULT_SAFE_COMMANDS);

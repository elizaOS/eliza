export interface ActionNotice {
  tone: string;
  text: string;
  /** When true, ShellOverlays shows an indeterminate spinner (long-running work). */
  busy?: boolean;
}

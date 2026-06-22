export interface ActionNotice {
  tone: string;
  text: string;
  /** When true, ShellOverlays shows an indeterminate spinner (long-running work). */
  busy?: boolean;
}

export type ActionTone = "info" | "success" | "error";

/** Signature of the shell `setActionNotice` callback threaded through settings hooks. */
export type ActionNoticeFn = (
  text: string,
  tone?: ActionTone,
  ttlMs?: number,
  once?: boolean,
  busy?: boolean,
) => void;

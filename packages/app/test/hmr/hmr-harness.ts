/**
 * Pure coordination helpers for the Playwright HMR dependency smoke.
 */

export type ViteProtocolEvent = {
  type: "update" | "full-reload";
  paths: string[];
  raw: string;
};

type ViteUpdatePayload = {
  type?: unknown;
  path?: unknown;
  updates?: Array<{ path?: unknown; acceptedPath?: unknown }>;
};

function normalizePath(value: string): string {
  try {
    return decodeURIComponent(value).replaceAll("\\", "/");
  } catch {
    // error-policy:J3 Malformed encoding remains a literal path candidate.
    return value.replaceAll("\\", "/");
  }
}

/** Parses only Vite protocol messages that can advance an HMR assertion. */
export function parseViteProtocolEvent(
  payload: string | Buffer,
): ViteProtocolEvent | null {
  const raw = typeof payload === "string" ? payload : payload.toString("utf8");
  let parsed: ViteUpdatePayload;
  try {
    parsed = JSON.parse(raw) as ViteUpdatePayload;
  } catch {
    // error-policy:J3 Non-JSON application frames are not Vite updates.
    return null;
  }

  if (parsed.type === "update") {
    const paths = (parsed.updates ?? []).flatMap((update) =>
      [update.path, update.acceptedPath].filter(
        (value): value is string => typeof value === "string",
      ),
    );
    return { type: "update", paths, raw };
  }
  if (parsed.type === "full-reload") {
    return {
      type: "full-reload",
      paths: typeof parsed.path === "string" ? [parsed.path] : [],
      raw,
    };
  }
  return null;
}

/** Returns the Vite URL suffixes that can identify a repository source file. */
export function viteSourceSuffixes(repoFile: string): string[] {
  const normalized = normalizePath(repoFile).replace(/^\/+/, "");
  const suffixes = [`/${normalized}`];
  const appPrefix = "packages/app/";
  if (normalized.startsWith(appPrefix)) {
    suffixes.push(`/${normalized.slice(appPrefix.length)}`);
  }
  return suffixes;
}

/** Correlates a Vite protocol update with the source file under test. */
export function viteEventMatchesSource(
  event: ViteProtocolEvent,
  repoFile: string,
): boolean {
  const suffixes = viteSourceSuffixes(repoFile);
  return event.paths.some((eventPath) => {
    const normalized = normalizePath(eventPath).split("?", 1)[0] ?? "";
    return suffixes.some((suffix) => normalized.endsWith(suffix));
  });
}

/** Correlates a browser module response with the source file under test. */
export function responseUrlMatchesSource(
  responseUrl: string,
  repoFile: string,
): boolean {
  try {
    const pathname = normalizePath(new URL(responseUrl).pathname);
    return viteSourceSuffixes(repoFile).some((suffix) =>
      pathname.endsWith(suffix),
    );
  } catch {
    // error-policy:J3 Malformed URLs cannot prove source reachability.
    return false;
  }
}

type RestoreAndQuarantineOptions = {
  restore: () => void;
  waitForRestoration?: () => Promise<void>;
  quarantine: () => Promise<void>;
};

function aggregateCleanupFailure(
  primaryError: unknown,
  cleanupError: unknown,
  message: string,
): AggregateError {
  return new AggregateError([primaryError, cleanupError], message, {
    cause: primaryError,
  });
}

/**
 * Restores a probe and always establishes a fresh-document boundary before
 * returning or rethrowing a restoration-update failure.
 */
export async function restoreAndQuarantine({
  restore,
  waitForRestoration,
  quarantine,
}: RestoreAndQuarantineOptions): Promise<void> {
  restore();
  let restorationFailed = false;
  let restorationError: unknown;
  if (waitForRestoration) {
    try {
      await waitForRestoration();
    } catch (error) {
      // error-policy:J2 Preserve restoration failure through quarantine.
      restorationFailed = true;
      restorationError = error;
    }
  }

  try {
    await quarantine();
  } catch (quarantineError) {
    // error-policy:J2 Aggregate with the earlier restoration failure.
    if (restorationFailed) {
      throw aggregateCleanupFailure(
        restorationError,
        quarantineError,
        "HMR restoration update and fresh-document quarantine both failed",
      );
    }
    throw quarantineError;
  }
  if (restorationFailed) throw restorationError;
}

type RunWithCleanupOptions = {
  run: () => Promise<void>;
  cleanup: () => Promise<void>;
};

/** Preserves an action failure when its mandatory cleanup also fails. */
export async function runWithCleanup({
  run,
  cleanup,
}: RunWithCleanupOptions): Promise<void> {
  let runFailed = false;
  let runError: unknown;
  try {
    await run();
  } catch (error) {
    // error-policy:J2 Preserve mutation failure through mandatory cleanup.
    runFailed = true;
    runError = error;
  }

  try {
    await cleanup();
  } catch (cleanupError) {
    // error-policy:J2 Aggregate with the earlier mutation failure.
    if (runFailed) {
      throw aggregateCleanupFailure(
        runError,
        cleanupError,
        "HMR mutation and restoration cleanup both failed",
      );
    }
    throw cleanupError;
  }
  if (runFailed) throw runError;
}

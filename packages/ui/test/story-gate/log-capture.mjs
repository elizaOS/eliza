/**
 * Reusable frontend log capture for Playwright-driven UI harnesses.
 *
 * Attaches listeners to a Page and collects structured console messages,
 * uncaught page errors, and failed/erroring network responses. Writes a
 * durable JSON artifact matching the PR_EVIDENCE convention so any UI test can
 * attach "real frontend logs" without bespoke plumbing.
 *
 * Usage:
 *   const cap = attachLogCapture(page, { allowConsoleNoise, allowNetworkNoise });
 *   // ... drive the page ...
 *   await cap.write("test-results/evidence/1234-frontend-logs.json");
 *   if (cap.hasErrors()) process.exitCode = 1;
 */

const DEFAULT_CONSOLE_NOISE = [
  /favicon/i,
  /\/__telemetry__/i,
  /^\[RenderTelemetry\]/,
  // Storybook dev/static runtime chatter that is not an app fault.
  /storybook/i,
  /\[vite\]/i,
  // React DevTools download nudge.
  /Download the React DevTools/i,
];

const DEFAULT_NETWORK_NOISE = [
  /\/__telemetry__/i,
  /google-analytics|googletagmanager|posthog|sentry\.io/i,
  // Storybook static assets that 404 harmlessly in some builds.
  /\/sb-/,
  /favicon\.svg|favicon\.ico/i,
];

/**
 * @param {import('playwright').Page} page
 * @param {{ label?: string, allowConsoleNoise?: RegExp[], allowNetworkNoise?: RegExp[] }} [opts]
 */
export function attachLogCapture(page, opts = {}) {
  const label = opts.label ?? "";
  const consoleNoise = opts.allowConsoleNoise ?? DEFAULT_CONSOLE_NOISE;
  const networkNoise = opts.allowNetworkNoise ?? DEFAULT_NETWORK_NOISE;

  /** @type {Array<{type:string,text:string,location?:string,label?:string}>} */
  const consoleMessages = [];
  /** @type {Array<{message:string,stack?:string,label?:string}>} */
  const pageErrors = [];
  /** @type {Array<{url:string,status:number,label?:string}>} */
  const failedResponses = [];
  /** @type {Array<{url:string,failure:string,label?:string}>} */
  const requestFailures = [];

  const onConsole = (msg) => {
    const type = msg.type();
    const text = msg.text();
    const loc = msg.location?.();
    consoleMessages.push({
      type,
      text,
      location: loc
        ? `${loc.url}:${loc.lineNumber}:${loc.columnNumber}`
        : undefined,
      label: label || undefined,
    });
  };
  const onPageError = (err) => {
    pageErrors.push({
      message: err.message ?? String(err),
      stack: err.stack,
      label: label || undefined,
    });
  };
  const onResponse = (resp) => {
    const status = resp.status();
    if (status < 400) return;
    const url = resp.url();
    if (networkNoise.some((re) => re.test(url))) return;
    failedResponses.push({ url, status, label: label || undefined });
  };
  const onRequestFailed = (req) => {
    const url = req.url();
    if (networkNoise.some((re) => re.test(url))) return;
    requestFailures.push({
      url,
      failure: req.failure()?.errorText ?? "unknown",
      label: label || undefined,
    });
  };

  page.on("console", onConsole);
  page.on("pageerror", onPageError);
  page.on("response", onResponse);
  page.on("requestfailed", onRequestFailed);

  const isErrorConsole = (m) =>
    m.type === "error" && !consoleNoise.some((re) => re.test(m.text));

  return {
    consoleMessages,
    pageErrors,
    failedResponses,
    requestFailures,
    /** Console errors that are not allow-listed noise. */
    consoleErrors() {
      return consoleMessages.filter(isErrorConsole);
    },
    hasErrors() {
      return (
        pageErrors.length > 0 ||
        this.consoleErrors().length > 0 ||
        failedResponses.length > 0 ||
        requestFailures.length > 0
      );
    },
    detach() {
      page.off("console", onConsole);
      page.off("pageerror", onPageError);
      page.off("response", onResponse);
      page.off("requestfailed", onRequestFailed);
    },
    snapshot() {
      return {
        capturedAt: new Date().toISOString(),
        label,
        summary: {
          consoleMessages: consoleMessages.length,
          consoleErrors: this.consoleErrors().length,
          pageErrors: pageErrors.length,
          failedResponses: failedResponses.length,
          requestFailures: requestFailures.length,
        },
        consoleMessages,
        pageErrors,
        failedResponses,
        requestFailures,
      };
    },
    async write(filePath) {
      const { mkdir, writeFile } = await import("node:fs/promises");
      const { dirname } = await import("node:path");
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, JSON.stringify(this.snapshot(), null, 2));
      return filePath;
    },
  };
}

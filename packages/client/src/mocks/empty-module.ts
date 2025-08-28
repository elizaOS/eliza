// Browser stub for Node-only modules (e.g., @sentry/node, @sentry/node-core)
// Provides explicit no-op implementations to avoid runtime errors during bundling.

export function init(_opts?: any): void {}
export function captureException(_err?: any): void {}
export async function flush(_timeout?: number): Promise<boolean> {
  return true;
}

// Some consumers might import a namespace object. Provide a default export too.
const defaultExport = { init, captureException, flush };
export default defaultExport;

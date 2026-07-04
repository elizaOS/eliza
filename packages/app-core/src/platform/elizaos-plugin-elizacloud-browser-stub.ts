/**
 * Browser-side inert alias for the server-only `@elizaos/plugin-elizacloud`
 * package. The plugin's real surface (cloud secrets, TTS/billing/relay routes,
 * wallet provisioning, the cloud client) runs only server-side; the renderer
 * only needs the named imports to statically resolve. Sync resolvers are noops,
 * async cloud-route handlers return `false` ("not handled here"), data fetchers
 * return empty results, and `isCloudProvisionedContainer` is a hard `false`.
 */

const noop = () => undefined;
const noopProxyHandler: ProxyHandler<typeof noop> = {
  get: (_target, key) => (key === "prototype" ? noop.prototype : noop),
  apply: () => undefined,
  ownKeys: (target) => Reflect.ownKeys(target),
  getOwnPropertyDescriptor: (target, key) =>
    Reflect.getOwnPropertyDescriptor(target, key) ?? {
      configurable: true,
      enumerable: false,
      value: noop,
      writable: true,
    },
};

// Sync void / secret / URL resolvers — server-only, nothing to resolve or
// mutate in a renderer.
export const clearCloudSecrets = noop;
export const ensureCloudTtsApiKeyAlias = noop;
export const getCloudSecret = noop;
export const mirrorCompatHeaders = noop;
export const normalizeCloudSiteUrl = noop;
export const normalizeCloudSecret = noop;
export const validateCloudBaseUrl = noop;
export const resolveCloudApiBaseUrl = noop;
export const resolveCloudApiKey = noop;
export const resolveCloudTtsBaseUrl = noop;
export const resolveElevenLabsApiKeyForCloudMode = noop;
export const persistCloudWalletCache = noop;
export const __resetCloudBaseUrlCache = noop;

// Async cloud-route handlers — `false` means "route not handled here", which
// is the correct answer in a renderer: there is no cloud server to dispatch to.
const routeNotHandled = async (): Promise<boolean> => false;
export const handleCloudBillingRoute = routeNotHandled;
export const handleCloudCompatRoute = routeNotHandled;
export const handleCloudRelayRoute = routeNotHandled;
export const handleCloudRoute = routeNotHandled;
export const handleCloudStatusRoutes = routeNotHandled;
export const handleCloudTtsPreviewRoute = routeNotHandled;

// Async data fetchers — empty results; there is no cloud backend in a renderer.
export const fetchCloudVoiceCatalog = async (): Promise<never[]> => [];
export const getOrCreateClientAddressKey = async (): Promise<{
  address: string;
}> => ({ address: "" });
export const provisionCloudWalletsBestEffort = async (): Promise<{
  descriptors: Record<string, never>;
  failures: never[];
  warnings: never[];
}> => ({ descriptors: {}, failures: [], warnings: [] });

// Server-only predicate — a browser/renderer context is never a
// cloud-provisioned container, so the browser alias is a hard `false`.
export const isCloudProvisionedContainer = (): boolean => false;

// Cloud client — server-only; the renderer never opens a cloud connection.
export class ElizaCloudClient {}

export default new Proxy(noop, noopProxyHandler);

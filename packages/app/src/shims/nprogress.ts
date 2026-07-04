/**
 * Browser-bundle shim aliased in place of the `nprogress` slim progress-bar
 * library, reimplementing its singleton API (configure/set/start/done/inc/
 * trickle plus status introspection) against a single `#nprogress` DOM node.
 * Progress is clamped to [0,1]; reaching 1 resets status to null and removes
 * the element. Both the default export and the named function exports mirror
 * nprogress so existing imports resolve unchanged.
 */
type NProgressSettings = {
  minimum: number;
  easing: string;
  positionUsing: string;
  speed: number;
  trickle: boolean;
  trickleRate: number;
  trickleSpeed: number;
  showSpinner: boolean;
  barSelector: string;
  spinnerSelector: string;
  parent: string;
  template: string;
};

export type NProgressOptions = Partial<NProgressSettings>;

type NProgressApi = {
  version: string;
  settings: NProgressSettings;
  status: number | null;
  configure(options?: NProgressOptions): NProgressApi;
  set(value: number): NProgressApi;
  start(): NProgressApi;
  done(force?: boolean): NProgressApi;
  inc(amount?: number): NProgressApi;
  trickle(): NProgressApi;
  isStarted(): boolean;
  render(): HTMLElement | null;
  remove(): void;
  isRendered(): boolean;
  getPositioningCSS(): string;
};

const clampProgress = (value: number): number => {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
};

const createProgressElement = (): HTMLElement | null => {
  if (typeof document === "undefined") return null;
  const existing = document.getElementById("nprogress");
  if (existing) return existing;

  const progress = document.createElement("div");
  progress.id = "nprogress";
  progress.setAttribute("aria-hidden", "true");

  const bar = document.createElement("div");
  bar.className = "bar";
  progress.appendChild(bar);

  const parent = document.body ?? document.documentElement;
  parent.appendChild(progress);
  return progress;
};

const api: NProgressApi = {
  version: "0.2.0",
  settings: {
    minimum: 0.08,
    easing: "ease",
    positionUsing: "",
    speed: 200,
    trickle: true,
    trickleRate: 0.02,
    trickleSpeed: 800,
    showSpinner: true,
    barSelector: '[role="bar"]',
    spinnerSelector: '[role="spinner"]',
    parent: "body",
    template:
      '<div class="bar" role="bar"><div class="peg"></div></div><div class="spinner" role="spinner"><div class="spinner-icon"></div></div>',
  },
  status: null as number | null,
  configure(options: NProgressOptions = {}) {
    Object.assign(api.settings, options);
    return api;
  },
  set(value: number) {
    api.status = value >= 1 ? null : clampProgress(value);
    api.render();
    if (api.status === null) api.remove();
    return api;
  },
  start() {
    if (api.status === null) {
      api.set(api.settings.minimum);
    }
    return api;
  },
  done(force?: boolean) {
    if (!force && api.status === null) return api;
    return api.set(1);
  },
  inc(amount?: number) {
    if (api.status === null) return api.start();
    const delta =
      typeof amount === "number"
        ? amount
        : api.status < 0.2
          ? 0.1
          : api.status < 0.5
            ? 0.04
            : api.status < 0.8
              ? 0.02
              : 0.005;
    return api.set(api.status + delta);
  },
  trickle() {
    return api.inc();
  },
  isStarted() {
    return typeof api.status === "number";
  },
  render() {
    return createProgressElement();
  },
  remove() {
    if (typeof document === "undefined") return;
    document.getElementById("nprogress")?.remove();
  },
  isRendered() {
    return (
      typeof document !== "undefined" &&
      document.getElementById("nprogress") !== null
    );
  },
  getPositioningCSS() {
    return "translate3d";
  },
};

export const configure = api.configure;
export const set = api.set;
export const start = api.start;
export const done = api.done;
export const inc = api.inc;
export const trickle = api.trickle;
export const isStarted = api.isStarted;
export const render = api.render;
export const remove = api.remove;
export const isRendered = api.isRendered;
export const getPositioningCSS = api.getPositioningCSS;
export default api;

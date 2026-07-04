/**
 * No-op React / react-dom / jsx-runtime module stubs installed as a Bun bundler
 * plugin so the scenario runtime can import plugin view modules (which pull in
 * React) without a real React dependency. `registerScenarioRuntimeReactStubs`
 * resolves any `react*` / `react-dom*` specifier to inert exports (components
 * render nothing, hooks return their initial value); registration is idempotent
 * and silently no-ops when not running under Bun. Consumed by runtime-factory.ts.
 */
type BunPluginBuilder = {
  onResolve: (
    options: { filter: RegExp },
    callback: (args: { path: string }) =>
      | {
          path: string;
          namespace: string;
        }
      | undefined,
  ) => void;
  onLoad: (
    options: { filter: RegExp; namespace?: string },
    callback: (args: { path: string }) => {
      contents: string;
      loader: "js";
    },
  ) => void;
};

type BunPluginHost = {
  plugin?: (plugin: {
    name: string;
    setup: (build: BunPluginBuilder) => void;
  }) => void;
};

const SCENARIO_REACT_STUB_NAMESPACE = "scenario-runner-react-stub";

const REACT_STUB_SOURCE = `
const NOOP = function scenarioReactStub() {
  return undefined;
};
const IDENTITY = function scenarioReactIdentity(value) {
  return value;
};
const FRAGMENT = Symbol.for("scenario-runner.react.fragment");
export const Fragment = FRAGMENT;
export const StrictMode = FRAGMENT;
export const Suspense = FRAGMENT;
export const Profiler = FRAGMENT;
export class Component {}
export class PureComponent {}
export const createElement = NOOP;
export const cloneElement = NOOP;
export const isValidElement = () => false;
export const createRef = () => ({ current: null });
export const createContext = () => ({
  Provider: NOOP,
  Consumer: NOOP,
  displayName: undefined,
});
export const memo = IDENTITY;
export const forwardRef = IDENTITY;
export const lazy = IDENTITY;
export const useState = (initial) => [initial, NOOP];
export const useReducer = (_reducer, initial) => [initial, NOOP];
export const useRef = (initial) => ({ current: initial });
export const useMemo = (factory) => factory();
export const useCallback = (callback) => callback;
export const useEffect = NOOP;
export const useLayoutEffect = NOOP;
export const useInsertionEffect = NOOP;
export const useContext = () => undefined;
export const useImperativeHandle = NOOP;
export const useId = () => "";
export const useTransition = () => [false, NOOP];
export const useDeferredValue = (value) => value;
export const useSyncExternalStore = (_subscribe, getSnapshot, getServerSnapshot) =>
  typeof getServerSnapshot === "function" ? getServerSnapshot() : getSnapshot();
export const useDebugValue = NOOP;
export const startTransition = (callback) =>
  typeof callback === "function" ? callback() : undefined;
export const Children = {
  map: NOOP,
  forEach: NOOP,
  count: () => 0,
  only: NOOP,
  toArray: () => [],
};
export const version = "0.0.0-scenario-runner-stub";
const React = {
  Fragment,
  StrictMode,
  Suspense,
  Profiler,
  Component,
  PureComponent,
  createElement,
  cloneElement,
  isValidElement,
  createRef,
  createContext,
  memo,
  forwardRef,
  lazy,
  useState,
  useReducer,
  useRef,
  useMemo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useInsertionEffect,
  useContext,
  useImperativeHandle,
  useId,
  useTransition,
  useDeferredValue,
  useSyncExternalStore,
  useDebugValue,
  startTransition,
  Children,
  version,
};
export default React;
`;

const REACT_JSX_RUNTIME_STUB_SOURCE = `
const NOOP = function scenarioJsxStub() {
  return undefined;
};
export const Fragment = Symbol.for("scenario-runner.react.fragment");
export const jsx = NOOP;
export const jsxs = NOOP;
export const jsxDEV = NOOP;
export default { Fragment, jsx, jsxs, jsxDEV };
`;

const REACT_DOM_STUB_SOURCE = `
const NOOP = function scenarioReactDomStub() {
  return undefined;
};
const ROOT = {
  render: NOOP,
  unmount: NOOP,
};
export const createPortal = NOOP;
export const flushSync = (callback) =>
  typeof callback === "function" ? callback() : undefined;
export const render = NOOP;
export const hydrate = NOOP;
export const unmountComponentAtNode = NOOP;
export const createRoot = () => ROOT;
export const hydrateRoot = () => ROOT;
export const renderToStaticMarkup = () => "";
export const renderToString = () => "";
export const version = "0.0.0-scenario-runner-stub";
export default {
  createPortal,
  flushSync,
  render,
  hydrate,
  unmountComponentAtNode,
  createRoot,
  hydrateRoot,
  renderToStaticMarkup,
  renderToString,
  version,
};
`;

let scenarioRuntimeReactStubsRegistered = false;

function scenarioReactStubSource(specifier: string): string {
  if (
    specifier.includes("jsx-runtime") ||
    specifier.includes("jsx-dev-runtime")
  ) {
    return REACT_JSX_RUNTIME_STUB_SOURCE;
  }
  if (specifier.includes("react-dom")) {
    return REACT_DOM_STUB_SOURCE;
  }
  return REACT_STUB_SOURCE;
}

export function registerScenarioRuntimeReactStubs(): void {
  if (scenarioRuntimeReactStubsRegistered) return;
  const bun = (globalThis as { Bun?: BunPluginHost }).Bun;
  if (typeof bun?.plugin !== "function") return;

  bun.plugin({
    name: "scenario-runner-react-stubs",
    setup(build) {
      build.onResolve(
        {
          filter:
            /^(?:react(?:\/jsx-runtime|\/jsx-dev-runtime)?|react-dom(?:\/client|\/server)?|@types\/react(?:\/jsx-runtime|\/jsx-dev-runtime)?|@types\/react-dom(?:\/client|\/server)?)$/,
        },
        (args) => ({
          path: args.path,
          namespace: SCENARIO_REACT_STUB_NAMESPACE,
        }),
      );
      build.onLoad(
        {
          filter: /.*/,
          namespace: SCENARIO_REACT_STUB_NAMESPACE,
        },
        (args) => ({
          contents: scenarioReactStubSource(args.path),
          loader: "js",
        }),
      );
      build.onLoad(
        { filter: /[/\\]@types[/\\]react(?:-dom)?[/\\].*\.d\.ts$/ },
        (args) => ({
          contents: scenarioReactStubSource(args.path),
          loader: "js",
        }),
      );
    },
  });
  scenarioRuntimeReactStubsRegistered = true;
}

registerScenarioRuntimeReactStubs();

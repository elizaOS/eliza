// react-jsx-runtime.cjs — mobile bundle stub for react/jsx-runtime and
// react/jsx-dev-runtime. The agent never renders JSX on-device; this
// satisfies the bundler so transitive imports through workspace plugin
// `src/index.ts` re-exports resolve cleanly.
"use strict";

const NOOP_FN = function noopJsxStub() {
  return undefined;
};

const FRAGMENT = Symbol("React.Fragment");

module.exports = {
  __esModule: true,
  Fragment: FRAGMENT,
  jsx: NOOP_FN,
  jsxs: NOOP_FN,
  jsxDEV: NOOP_FN,
};

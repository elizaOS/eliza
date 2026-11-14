import type { Elements, ReactElement } from "./index.d.ts";

export namespace JSX {
  interface Element extends ReactElement {}
  interface ElementChildrenAttribute { children: unknown }
  interface IntrinsicElements extends Elements {}
}

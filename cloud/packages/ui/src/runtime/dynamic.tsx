import { type ComponentType, createElement, lazy, Suspense } from "react";

type DynamicModule<P> = ComponentType<P> | { default: ComponentType<P> };

type DynamicOptions = {
  loading?: ComponentType;
  ssr?: boolean;
};

function normalizeModule<P>(mod: DynamicModule<P>): { default: ComponentType<P> } {
  if (typeof mod === "function") {
    return { default: mod };
  }
  return mod;
}

export default function dynamic<P extends object>(
  loader: () => Promise<DynamicModule<P>>,
  options: DynamicOptions = {},
): ComponentType<P> {
  const LazyComponent = lazy(async () => normalizeModule(await loader()));
  const Loading = options.loading;

  function DynamicComponent(props: P) {
    return (
      <Suspense fallback={Loading ? <Loading /> : null}>
        {createElement(LazyComponent, props)}
      </Suspense>
    );
  }

  return DynamicComponent;
}

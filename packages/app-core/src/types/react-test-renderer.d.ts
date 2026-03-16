declare module "react-test-renderer" {
  import type * as React from "react";

  export interface ReactTestInstance {
    type: unknown;
    props: Record<string, unknown>;
    children: Array<ReactTestInstance | string>;
    parent: ReactTestInstance | null;
    find(predicate: (node: ReactTestInstance) => boolean): ReactTestInstance;
    findAll(
      predicate: (node: ReactTestInstance) => boolean,
      options?: { deep?: boolean },
    ): ReactTestInstance[];
    findByType(type: unknown): ReactTestInstance;
    findAllByType(
      type: unknown,
      options?: { deep?: boolean },
    ): ReactTestInstance[];
    findByProps(props: Record<string, unknown>): ReactTestInstance;
    findAllByProps(
      props: Record<string, unknown>,
      options?: { deep?: boolean },
    ): ReactTestInstance[];
  }

  export interface ReactTestRenderer {
    root: ReactTestInstance;
    update(nextElement: React.ReactElement): void;
    unmount(nextElement?: React.ReactElement): void;
    toJSON(): unknown;
  }

  export function create(element: React.ReactElement): ReactTestRenderer;
  export function act<T>(
    callback: () => Promise<T>,
  ): Promise<Awaited<T> | undefined>;
  export function act<T>(callback: () => T): T;

  const TestRenderer: {
    create: typeof create;
    act: typeof act;
  };

  export default TestRenderer;
}

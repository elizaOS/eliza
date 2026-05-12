declare module "bun" {
  export function build(options: {
    entrypoints: string[];
    outdir: string;
    target?: string;
    format?: string;
    sourcemap?: string;
    minify?: boolean;
    external?: string[];
  }): Promise<unknown>;
}

interface ImportMeta {
  readonly dir: string;
}

declare const Bun: {
  spawn(
    cmd: string[],
    options?: {
      cwd?: string;
      stdio?: [string, string, string];
    }
  ): {
    exited: Promise<number>;
  };
};

declare module "cross-spawn" {
  import type {
    ChildProcess,
    SpawnOptionsWithoutStdio,
    SpawnSyncOptions,
    SpawnSyncReturns,
  } from "node:child_process";

  function spawn(
    command: string,
    args?: readonly string[],
    options?: SpawnOptionsWithoutStdio
  ): ChildProcess;
  function spawn(command: string, options?: SpawnOptionsWithoutStdio): ChildProcess;

  namespace spawn {
    function sync(
      command: string,
      args?: readonly string[],
      options?: SpawnSyncOptions
    ): SpawnSyncReturns<Buffer>;
    function sync(command: string, options?: SpawnSyncOptions): SpawnSyncReturns<Buffer>;
  }

  export default spawn;
}

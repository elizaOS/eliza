declare module "node:sqlite" {
  export class DatabaseSync {
    constructor(path: string, options?: { readOnly?: boolean });
    prepare(sql: string): {
      all(...params: unknown[]): unknown[];
    };
    close(): void;
  }

  const _default: {
    DatabaseSync: typeof DatabaseSync;
  };

  export default _default;
}

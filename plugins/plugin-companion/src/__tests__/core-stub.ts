/** Test-only stub so vitest does not need a built @elizaos/core dist. */
export const logger = {
  info(_message?: unknown) {},
  warn(_message?: unknown) {},
  error(_message?: unknown) {},
  debug(_message?: unknown) {},
};

export class Service {
  protected runtime?: unknown;
  constructor(runtime?: unknown) {
    this.runtime = runtime;
  }
}

/** Describes whether a failed inbound delivery may safely be attempted again. */

export class WechatDeliveryError extends Error {
  readonly sideEffectCommitted: boolean;

  constructor(
    message: string,
    options: { cause: unknown; sideEffectCommitted: boolean },
  ) {
    super(message, { cause: options.cause });
    this.name = "WechatDeliveryError";
    this.sideEffectCommitted = options.sideEffectCommitted;
  }
}

export function hasCommittedWechatSideEffect(error: unknown): boolean {
  return error instanceof WechatDeliveryError && error.sideEffectCommitted;
}

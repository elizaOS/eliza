import {
  type NativeCloudSignInAuthenticated,
  NativeCloudSignInError,
  type NativeCloudSignInGoogleOutcome,
  type NativeCloudSignInPort,
  type NativeCloudSignInReadiness,
  nativeSignInCodeStarted,
  nativeSignInGoogleOutcome,
  nativeSignInReadiness,
  nativeSignInVerified,
  normalizeNativeSignInCode,
  validNativeSignInEmail,
  validNativeSignInPhone,
} from "@elizaos/auth/auth/native-cloud-sign-in";

export type NativeSignInStep =
  | { kind: "methods" }
  | {
      kind: "code";
      channel: "email" | "phone";
      attemptId: string;
      destination: string;
      expiresAt: number;
      resendAt: number;
    }
  | {
      kind: "mfa";
      attemptId: string;
      method: "totp" | "sms" | "passkey";
      expiresAt: number;
    };

export interface NativeSignInSnapshot<E extends string = string> {
  readonly environment: E;
  readonly step: NativeSignInStep;
  readonly readiness: NativeCloudSignInReadiness | null | "loading";
  readonly stage: "choosing" | "authenticating" | "activating" | "complete";
  readonly busy: boolean;
  readonly operation: "google" | "send-code" | "verify-code" | "return" | null;
  readonly error: NativeCloudSignInError | null;
  /** Activation errors belong to the stored session, not another code attempt. */
  readonly activationError: unknown;
}

export interface NativeSignInOwner<E extends string> {
  readonly environment: E;
  /** The application captures its owner/session epoch before constructing this attempt. */
  current(): boolean;
  /** Verify the stored session before reporting application readiness. */
  activate(
    outcome: NativeCloudSignInAuthenticated<E>,
    signal: AbortSignal,
  ): Promise<void> | void;
  /** Join the application's existing session-operation owner. It must reject a busy or
   * retired operation; it must not silently skip action and report success. */
  runOperation?(
    action: (signal: AbortSignal) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void>;
  abandoned(error: NativeCloudSignInError): void;
}

/** One mounted request's sign-in lifecycle. Native storage remains the credential owner. */
export class NativeCloudSignInController<E extends string> {
  private readonly port: NativeCloudSignInPort<E>;
  private readonly owner: Readonly<NativeSignInOwner<E>>;
  private snapshot: NativeSignInSnapshot<E>;
  private readonly listeners = new Set<() => void>();
  private readonly handles = new Set<unknown>();
  private disposed = false;
  private started = false;
  private completed = false;
  private generation = 0;
  private probe = 0;
  private lifetime = 0;
  private pending: AbortController | null = null;
  private cancellation: Promise<void> | null = null;
  private cancellationRequired = false;
  private nativeAttemptRetired = false;
  /** Set only by an actual native dispatch, never by a retained event. */
  private requestId: string | null = null;
  private authenticated: NativeCloudSignInAuthenticated<E> | null = null;
  private activation: Promise<void> | null = null;
  private returned: { owner: AbortController; finish(): void } | null = null;

  constructor(port: NativeCloudSignInPort<E>, owner: NativeSignInOwner<E>) {
    this.port = port;
    this.owner = Object.freeze({ ...owner });
    this.snapshot = Object.freeze({
      environment: owner.environment,
      step: Object.freeze({ kind: "methods" }),
      readiness: "loading",
      stage: "choosing",
      busy: false,
      operation: null,
      error: null,
      activationError: null,
    });
  }

  readonly getSnapshot = () => this.snapshot;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private current() {
    return !this.disposed && !this.completed && this.owner.current();
  }
  private publish(patch: Partial<NativeSignInSnapshot<E>>) {
    if (!this.current()) return;
    this.snapshot = Object.freeze({
      ...this.snapshot,
      ...patch,
      ...(patch.step ? { step: Object.freeze({ ...patch.step }) } : {}),
      ...(patch.readiness && patch.readiness !== "loading"
        ? { readiness: Object.freeze({ ...patch.readiness }) }
        : {}),
    });
    for (const listener of this.listeners) listener();
  }
  private check(generation: number, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.current() || generation !== this.generation)
      throw new DOMException("Sign-in owner changed", "AbortError");
  }
  /** Another session operation superseded a still-pending optional probe. */
  retireReadiness() {
    ++this.probe;
    if (this.snapshot.readiness === "loading")
      this.publish({ readiness: null });
  }
  reportIncomplete(value: unknown) {
    if (this.current() && !this.authenticated && !this.cancellationRequired)
      this.fail(value);
  }
  private fail(cause: unknown) {
    const error = NativeCloudSignInError.from(cause);
    const spent = ["expired", "attempts-exhausted", "state-mismatch"].includes(
      error.code,
    );
    this.publish({ error, ...(spent ? { step: { kind: "methods" } } : {}) });
    return error;
  }
  private async remove(handle: unknown) {
    if (!handle || typeof handle !== "object") return;
    const remove = Reflect.get(handle, "remove");
    if (typeof remove !== "function") return;
    try {
      await remove.call(handle);
    } catch {
      /* Already retired listeners need no retry. */
    }
  }

  /** Start once after mounting, so discarded React renders create no native listeners. */
  start(refreshNegative = false) {
    // React StrictMode replays mounting effects on the same render instance.
    // A disposed generation stays retired; the replay starts a new one.
    if (this.disposed && !this.completed) {
      this.disposed = false;
      this.started = false;
    }
    if (this.started || !this.current()) return;
    this.started = true;
    const lifetime = ++this.lifetime;
    void this.refreshReadiness(refreshNegative);
    if (!this.port.addListener) return;
    const listen = (
      event: "signInCompleted" | "signInIncomplete" | "signInMfaRequired",
      callback: (value: unknown) => void,
    ) => {
      void this.port
        .addListener?.(event, (value) => {
          if (this.current() && lifetime === this.lifetime) callback(value);
        })
        .then(
          (handle) => {
            if (!this.current() || lifetime !== this.lifetime)
              void this.remove(handle);
            else this.handles.add(handle);
          },
          () => {
            /* Explicit methods remain available without retained events. */
          },
        );
    };
    listen("signInCompleted", (value) => {
      void this.acceptReturn(value);
    });
    listen("signInMfaRequired", (value) => {
      void this.acceptReturn(value);
    });
    listen("signInIncomplete", (value) => {
      this.reportIncomplete(value);
    });
  }

  async refreshReadiness(refreshNegative = false) {
    if (!this.current()) return;
    const probe = ++this.probe;
    const generation = this.generation;
    this.publish({ readiness: "loading" });
    const eligible = () =>
      this.current() &&
      probe === this.probe &&
      generation === this.generation &&
      this.snapshot.step.kind === "methods";
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const pending = Promise.resolve(
        this.port.status?.({
          environment: this.owner.environment,
          refreshNegative,
        }),
      );
      const read = pending.then(
        (value) => {
          if (eligible())
            this.publish({ readiness: nativeSignInReadiness(value) });
        },
        () => {
          if (eligible()) this.publish({ readiness: null });
        },
      );
      await Promise.race([
        read,
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            if (eligible()) this.publish({ readiness: null });
            resolve();
          }, 6000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async run(
    work: (generation: number, signal: AbortSignal) => Promise<void>,
    operation: NonNullable<NativeSignInSnapshot<E>["operation"]> = "return",
  ) {
    if (!this.current() || this.snapshot.busy || this.authenticated) return;
    const generation = ++this.generation;
    const pending = new AbortController();
    this.pending = pending;
    this.publish({
      busy: true,
      operation,
      error: null,
      stage: "authenticating",
    });
    try {
      // A cancelled native attempt must finish retiring before a new method is
      // dispatched. Multiple cleanup paths share the same acknowledgement.
      if (this.cancellationRequired) await this.cancelNative();
      this.check(generation, pending.signal);
      const execute = async (signal: AbortSignal) => {
        const cancel = () => pending.abort(signal.reason);
        signal.addEventListener("abort", cancel, { once: true });
        try {
          if (signal.aborted) cancel();
          this.check(generation, pending.signal);
          this.nativeAttemptRetired = false;
          const returned = new Promise<void>((finish) => {
            this.returned = { owner: pending, finish };
          });
          await this.untilAborted(
            Promise.race([work(generation, pending.signal), returned]),
            pending.signal,
          );
        } finally {
          signal.removeEventListener("abort", cancel);
          if (this.returned?.owner === pending) this.returned = null;
        }
      };
      if (this.owner.runOperation)
        await this.owner.runOperation(execute, pending.signal);
      else await execute(pending.signal);
    } catch (error) {
      if (
        this.current() &&
        generation === this.generation &&
        !pending.signal.aborted
      )
        this.fail(error);
    } finally {
      if (this.pending === pending) {
        this.pending = null;
        this.publish({
          busy: false,
          operation: null,
          ...(this.authenticated ? {} : { stage: "choosing" }),
        });
      }
    }
  }

  private async untilAborted(work: Promise<void>, signal: AbortSignal) {
    let aborted: (() => void) | undefined;
    try {
      await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          aborted = () => {
            // Account activation can publish the new session and unmount its
            // sign-in view before the owner's promise unwinds. The key is
            // already committed; retiring renderer work must not cancel native
            // sign-in after that authenticated boundary.
            if (!this.authenticated) void this.cancelNative();
            reject(signal.reason);
          };
          signal.addEventListener("abort", aborted, { once: true });
          if (signal.aborted) aborted();
        }),
      ]);
    } finally {
      if (aborted) signal.removeEventListener("abort", aborted);
    }
  }
  private cancelNative() {
    if (this.cancellation) return this.cancellation;
    const requestId = this.requestId;
    // Readiness and queued host work own no native attempt. In particular,
    // disposing either cannot cancel a different mounted request.
    if (!requestId) {
      this.nativeAttemptRetired = true;
      return Promise.resolve();
    }
    this.cancellationRequired = true;
    if (!this.cancellation) {
      // Capture the originating ID before disposal or a later method changes state.
      const cancellation = (async () => this.port.cancel({ requestId }))();
      this.cancellation = cancellation;
      void cancellation.then(
        () => {
          if (this.cancellation === cancellation) {
            this.cancellation = null;
            this.cancellationRequired = false;
            this.nativeAttemptRetired = true;
            if (this.requestId === requestId) this.requestId = null;
          }
        },
        () => {
          // A lost bridge acknowledgement does not prove native retirement.
          // Keep the fence, but allow the next explicit action to retry cancel.
          if (this.cancellation === cancellation) this.cancellation = null;
        },
      );
    }
    return this.cancellation;
  }

  private async verified(
    answer: unknown,
    attemptId: string,
    generation: number,
    signal: AbortSignal,
  ) {
    this.check(generation, signal);
    const outcome = nativeSignInVerified(answer, this.owner.environment);
    this.checkResponseRequest(outcome);
    if (outcome.status === "authenticated")
      return this.activate(outcome, generation, signal);
    this.publish({
      step: {
        kind: "mfa",
        attemptId: outcome.attemptId ?? attemptId,
        method: outcome.method,
        expiresAt: outcome.expiresAt,
      },
    });
  }
  private checkResponseRequest(outcome: { requestId?: string }) {
    // Older hosts can answer a directly awaited RPC without correlation metadata.
    // A supplied echo, however, must always identify our native dispatch.
    if (outcome.requestId !== undefined && outcome.requestId !== this.requestId)
      throw new NativeCloudSignInError("state-mismatch");
  }
  private async activate(
    outcome: NativeCloudSignInAuthenticated<E>,
    generation: number,
    signal: AbortSignal,
  ) {
    this.check(generation, signal);
    if (this.activation) return this.activation;
    if (this.authenticated) return;
    this.authenticated = outcome;
    this.publish({ stage: "activating", activationError: null });
    this.activation = Promise.resolve().then(async () => {
      try {
        this.check(generation, signal);
        await this.owner.activate(outcome, signal);
        this.check(generation, signal);
        this.publish({ stage: "complete", busy: false });
        this.completed = true;
      } catch (error) {
        if (this.current() && generation === this.generation && !signal.aborted)
          this.publish({
            stage: "activating",
            activationError: error,
            busy: false,
          });
      }
    });
    return this.activation;
  }

  startEmail(email: string) {
    const address = email.trim();
    if (!validNativeSignInEmail(address)) {
      this.fail(new NativeCloudSignInError("invalid-email"));
      return Promise.resolve();
    }
    return this.run(async (generation, signal) => {
      const requestId = crypto.randomUUID();
      this.requestId = requestId;
      const started = nativeSignInCodeStarted(
        await this.port.startEmail({
          environment: this.owner.environment,
          email: address,
          requestId,
        }),
      );
      this.check(generation, signal);
      this.publish({
        step: {
          kind: "code",
          channel: "email",
          destination: address,
          ...started,
        },
      });
    }, "send-code");
  }
  startPhone(phone: string) {
    const number = phone.trim();
    if (!validNativeSignInPhone(number)) {
      this.fail(new NativeCloudSignInError("invalid-phone"));
      return Promise.resolve();
    }
    return this.run(async (generation, signal) => {
      if (!this.port.startPhone)
        throw new NativeCloudSignInError("unavailable");
      const requestId = crypto.randomUUID();
      this.requestId = requestId;
      const started = nativeSignInCodeStarted(
        await this.port.startPhone({
          environment: this.owner.environment,
          phone: number,
          requestId,
        }),
      );
      this.check(generation, signal);
      this.publish({
        step: {
          kind: "code",
          channel: "phone",
          destination: number,
          ...started,
        },
      });
    }, "send-code");
  }
  startGoogle() {
    return this.run(async (generation, signal) => {
      const requestId = crypto.randomUUID();
      this.requestId = requestId;
      const outcome = nativeSignInGoogleOutcome(
        await this.port.startGoogle({
          environment: this.owner.environment,
          requestId,
        }),
        this.owner.environment,
      );
      this.check(generation, signal);
      this.checkResponseRequest(outcome);
      if (outcome.status === "authenticated")
        await this.activate(outcome, generation, signal);
      else
        this.publish({
          step: {
            kind: "mfa",
            attemptId: outcome.attemptId,
            method: outcome.method,
            expiresAt: outcome.expiresAt,
          },
        });
    }, "google");
  }
  verify(code: string) {
    const step = this.snapshot.step;
    if (step.kind === "methods") return Promise.resolve();
    const digits = normalizeNativeSignInCode(code);
    if (!digits) {
      this.fail(new NativeCloudSignInError("invalid-code"));
      return Promise.resolve();
    }
    return this.run(async (generation, signal) => {
      let result: unknown;
      if (step.kind === "mfa")
        result = await this.port.verifyMfa({
          attemptId: step.attemptId,
          code: digits,
        });
      else if (step.channel === "email")
        result = await this.port.verifyEmail({
          attemptId: step.attemptId,
          code: digits,
        });
      else {
        if (!this.port.verifyPhone)
          throw new NativeCloudSignInError("unavailable");
        result = await this.port.verifyPhone({
          attemptId: step.attemptId,
          code: digits,
        });
      }
      await this.verified(result, step.attemptId, generation, signal);
    }, "verify-code");
  }
  resend() {
    const step = this.snapshot.step;
    return step.kind !== "code"
      ? Promise.resolve()
      : step.channel === "email"
        ? this.startEmail(step.destination)
        : this.startPhone(step.destination);
  }
  async acceptReturn(value: unknown) {
    if (
      !this.current() ||
      this.authenticated ||
      this.cancellationRequired ||
      !this.requestId
    )
      return;
    let outcome: NativeCloudSignInGoogleOutcome<E>;
    try {
      outcome = nativeSignInGoogleOutcome(value, this.owner.environment);
      // A retained event cannot establish an interactive request. Cold-start
      // recovery reads the current installed credential through the session owner.
      if (outcome.requestId !== this.requestId) return;
    } catch {
      return;
    }
    // A retained completion may race the pending native call. The same generation
    // accepts it once; the pending call becomes inert after activation starts.
    if (!this.pending)
      return this.run(async (generation, signal) => {
        await this.acceptOutcome(outcome, generation, signal);
      });
    const pending = this.pending;
    const generation = this.generation;
    const accepted = await this.acceptOutcome(
      outcome,
      generation,
      pending.signal,
    );
    // A validated retained result completes a native call whose renderer
    // promise did not survive backgrounding. MFA retires only that renderer
    // callback; its native attempt remains available for code verification.
    if (accepted && this.returned?.owner === pending) {
      if (outcome.status === "mfa" && generation === this.generation)
        ++this.generation;
      this.returned.finish();
    }
  }
  private async acceptOutcome(
    outcome: NativeCloudSignInGoogleOutcome<E>,
    generation: number,
    signal: AbortSignal,
  ) {
    if (outcome.status === "authenticated") {
      await this.activate(outcome, generation, signal);
      return true;
    }
    if (!this.port.resumeMfa) return false;
    try {
      const resumed = await this.port.resumeMfa({
        attemptId: outcome.attemptId,
        environment: this.owner.environment,
      });
      this.check(generation, signal);
      if (
        resumed &&
        typeof resumed === "object" &&
        Reflect.get(resumed, "active") === true &&
        outcome.expiresAt > Date.now()
      ) {
        this.publish({
          step: {
            kind: "mfa",
            attemptId: outcome.attemptId,
            method: outcome.method,
            expiresAt: outcome.expiresAt,
          },
          error: null,
        });
        return true;
      }
    } catch (error) {
      if (this.current() && generation === this.generation) this.fail(error);
    }
    return false;
  }
  async chooseAnotherMethod() {
    if (!this.current() || this.authenticated) return;
    ++this.generation;
    this.pending?.abort();
    this.pending = null;
    this.publish({ busy: true });
    try {
      await this.cancelNative();
    } catch (error) {
      this.fail(error);
      this.publish({ busy: false, operation: null });
      return;
    }
    this.publish({
      step: { kind: "methods" },
      busy: false,
      error: null,
      stage: "choosing",
    });
  }
  async retryActivation() {
    const outcome = this.authenticated;
    if (!outcome || !this.current() || this.snapshot.busy) return;
    const generation = this.generation;
    const pending = new AbortController();
    this.pending = pending;
    this.publish({ busy: true, activationError: null, stage: "activating" });
    try {
      const execute = async (signal: AbortSignal) => {
        const cancel = () => pending.abort(signal.reason);
        signal.addEventListener("abort", cancel, { once: true });
        try {
          if (signal.aborted) cancel();
          this.check(generation, pending.signal);
          await this.owner.activate(outcome, pending.signal);
        } finally {
          signal.removeEventListener("abort", cancel);
        }
      };
      if (this.owner.runOperation)
        await this.owner.runOperation(execute, pending.signal);
      else await execute(pending.signal);
      this.check(generation, pending.signal);
      this.publish({ busy: false, stage: "complete" });
      this.completed = true;
    } catch (error) {
      if (
        this.current() &&
        generation === this.generation &&
        !pending.signal.aborted
      )
        this.publish({ busy: false, activationError: error });
    } finally {
      if (this.pending === pending) this.pending = null;
    }
  }
  async leave() {
    if (!this.current()) return;
    const generation = ++this.generation;
    this.pending?.abort();
    this.pending = null;
    this.publish({ busy: true, operation: null });
    if (!this.authenticated) {
      try {
        await this.cancelNative();
      } catch (error) {
        if (this.current() && generation === this.generation) {
          this.fail(error);
          this.publish({ busy: false });
        }
        return;
      }
    }
    if (!this.current() || generation !== this.generation) return;
    try {
      this.owner.abandoned(new NativeCloudSignInError("cancelled"));
    } finally {
      this.dispose();
    }
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    ++this.lifetime;
    ++this.generation;
    ++this.probe;
    // Completion can unmount the view while its host operation unwinds. That
    // successful transaction must not be reported as a cancelled sign-in.
    if (!this.completed) this.pending?.abort();
    this.pending = null;
    for (const handle of this.handles) void this.remove(handle);
    this.handles.clear();
    this.listeners.clear();
    if (!this.completed && !this.authenticated && !this.nativeAttemptRetired)
      void this.cancelNative();
  }
}

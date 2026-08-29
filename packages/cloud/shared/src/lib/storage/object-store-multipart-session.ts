/** Serialized multipart session state and bounded one-part memory admission. */

import {
  type ExactObjectStorageBackend,
  type ImmutableObjectUploadReceipt,
  ObjectStorageLifecycleError,
} from "./object-store";
import {
  createRequestContext,
  observedOperation,
  type ProviderRequestContext,
} from "./object-store-multipart-control";
import {
  exactPartSize,
  hasEveryExactPart,
  isNoSuchUpload,
  lifecycle,
  type MultipartObjectPartReceipt,
  type MultipartObjectRequestControl,
  type MultipartObjectUploadHandle,
  type MultipartObjectUploadSession,
  MultipartObjectPartReceipt as PartReceipt,
  type ProviderMultipartHandle,
  type QueuedOperation,
  sha256Hex,
  sha256HexToBase64,
  snapshotBody,
  type UploadMultipartObjectPartInput,
  validateReceiptForHandle,
} from "./object-store-multipart-types";
import { reconcileCompletedObject } from "./object-store-multipart-verification";

class MultipartObjectUploadSessionImpl implements MultipartObjectUploadSession {
  readonly handle: MultipartObjectUploadHandle;
  readonly #backend: ExactObjectStorageBackend;
  readonly #provider: ProviderMultipartHandle;
  readonly #acknowledged = new Map<number, MultipartObjectPartReceipt>();
  readonly #slotSha256 = new Map<number, string>();
  #state: "open" | "completed" | "aborted";
  #completedReceipt: ImmutableObjectUploadReceipt | null;
  #partAdmissionHeld = false;
  #queue: Promise<void> = Promise.resolve();

  constructor(input: {
    backend: ExactObjectStorageBackend;
    provider: ProviderMultipartHandle;
    handle: MultipartObjectUploadHandle;
    acknowledgedParts?: readonly MultipartObjectPartReceipt[];
    completedReceipt?: ImmutableObjectUploadReceipt;
  }) {
    this.#backend = input.backend;
    this.#provider = input.provider;
    this.handle = input.handle;
    this.#state = input.completedReceipt ? "completed" : "open";
    this.#completedReceipt = input.completedReceipt ?? null;
    for (const receipt of input.acknowledgedParts ?? []) {
      validateReceiptForHandle(this.handle, receipt);
      if (this.#acknowledged.has(receipt.partNumber)) {
        throw lifecycle(
          "OBJECT_STORAGE_MULTIPART_HANDLE_MISMATCH",
          "Multipart resume received duplicate part receipts",
        );
      }
      this.#acknowledged.set(receipt.partNumber, receipt);
      this.#slotSha256.set(receipt.partNumber, receipt.bodySha256);
    }
  }

  acknowledgedParts(): readonly MultipartObjectPartReceipt[] {
    return Object.freeze(
      [...this.#acknowledged.values()].sort((left, right) => left.partNumber - right.partNumber),
    );
  }

  #enqueue<T>(start: () => QueuedOperation<T> | Promise<QueuedOperation<T>>): Promise<T> {
    let resolveResult!: (value: T | PromiseLike<T>) => void;
    let rejectResult!: (error: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const previous = this.#queue;
    this.#queue = previous
      .then(async () => {
        let operation: QueuedOperation<T>;
        try {
          operation = await start();
        } catch (error) {
          rejectResult(error);
          return;
        }
        operation.result.then(resolveResult, rejectResult);
        await operation.settlement;
      })
      .catch(() => undefined);
    return result;
  }

  uploadPart(input: UploadMultipartObjectPartInput): Promise<MultipartObjectPartReceipt> {
    let expectedSize: number;
    try {
      expectedSize = exactPartSize(this.handle, input.partNumber);
    } catch (error) {
      return Promise.reject(error);
    }
    if (input.body.byteLength !== expectedSize) {
      return Promise.reject(
        lifecycle(
          "OBJECT_STORAGE_MULTIPART_INVALID",
          "Multipart part body does not match its fixed exact slot size",
        ),
      );
    }
    if (this.#partAdmissionHeld) {
      return Promise.reject(
        lifecycle(
          "OBJECT_STORAGE_MULTIPART_BACKPRESSURE",
          "Multipart session already owns one unsettled part buffer",
        ),
      );
    }
    this.#partAdmissionHeld = true;
    let body: Uint8Array;
    try {
      body = snapshotBody(input.body);
    } catch (error) {
      this.#partAdmissionHeld = false;
      return Promise.reject(
        error instanceof ObjectStorageLifecycleError
          ? error
          : lifecycle(
              "OBJECT_STORAGE_MULTIPART_INVALID",
              "Multipart part body could not be copied into provider ownership",
              error,
            ),
      );
    }

    return this.#enqueue(async () => {
      let providerDispatched = false;
      let context: ProviderRequestContext;
      try {
        context = createRequestContext(input.control);
      } catch (error) {
        body.fill(0);
        this.#partAdmissionHeld = false;
        throw error;
      }
      return observedOperation(context, async () => {
        try {
          context.ensureActive();
          if (this.#state !== "open") {
            throw lifecycle(
              "OBJECT_STORAGE_MULTIPART_INVALID",
              "Multipart session is no longer open for parts",
            );
          }
          const bodySha256 = await sha256Hex(body);
          context.ensureActive();
          const priorSha256 = this.#slotSha256.get(input.partNumber);
          if (priorSha256 !== undefined && priorSha256 !== bodySha256) {
            throw lifecycle(
              "OBJECT_STORAGE_MULTIPART_PART_CONFLICT",
              "Multipart part replay changed the exact slot body",
            );
          }
          this.#slotSha256.set(input.partNumber, bodySha256);
          const acknowledged = this.#acknowledged.get(input.partNumber);
          if (acknowledged) return acknowledged;

          const expectedBase64 = sha256HexToBase64(bodySha256);
          providerDispatched = true;
          const providerRequest = Promise.resolve().then(() =>
            this.#provider.uploadPart(input.partNumber, body, expectedBase64, context.signal),
          );
          const tracked = providerRequest
            .then((part) => {
              if (
                part.partNumber !== input.partNumber ||
                (part.checksumBase64 !== undefined && part.checksumBase64 !== expectedBase64)
              ) {
                throw lifecycle(
                  "OBJECT_STORAGE_MULTIPART_PART_FAILED",
                  "Multipart provider acknowledged another exact part",
                );
              }
              const receipt = new PartReceipt({
                handleFingerprint: this.handle.handleFingerprint,
                partNumber: input.partNumber,
                sizeBytes: body.byteLength,
                bodySha256,
                etag: part.etag,
              });
              const prior = this.#acknowledged.get(input.partNumber);
              if (
                prior &&
                (prior.etag !== receipt.etag || prior.bodySha256 !== receipt.bodySha256)
              ) {
                throw lifecycle(
                  "OBJECT_STORAGE_MULTIPART_PART_CONFLICT",
                  "Multipart provider returned conflicting acknowledgements for one slot",
                );
              }
              this.#acknowledged.set(input.partNumber, prior ?? receipt);
              return prior ?? receipt;
            })
            .finally(() => {
              body.fill(0);
              this.#partAdmissionHeld = false;
            });
          try {
            return await context.race(tracked);
          } catch (error) {
            if (error instanceof ObjectStorageLifecycleError) throw error;
            if (isNoSuchUpload(error)) {
              throw lifecycle(
                "OBJECT_STORAGE_MULTIPART_NO_SUCH_UPLOAD",
                "Multipart upload disappeared while writing a part",
              );
            }
            throw lifecycle(
              "OBJECT_STORAGE_MULTIPART_PART_FAILED",
              "Multipart provider did not acknowledge the exact part",
              error,
            );
          }
        } finally {
          if (!providerDispatched) {
            body.fill(0);
            this.#partAdmissionHeld = false;
          }
        }
      });
    });
  }

  complete(control: MultipartObjectRequestControl): Promise<ImmutableObjectUploadReceipt> {
    return this.#enqueue(() => {
      const context = createRequestContext(control);
      return observedOperation(context, async () => {
        context.ensureActive();
        if (this.#state === "completed" && this.#completedReceipt) return this.#completedReceipt;
        if (this.#state !== "open") {
          throw lifecycle(
            "OBJECT_STORAGE_MULTIPART_INVALID",
            "Multipart session is no longer open for completion",
          );
        }
        const parts = this.acknowledgedParts();
        if (!hasEveryExactPart(this.handle, parts)) {
          throw lifecycle(
            "OBJECT_STORAGE_MULTIPART_INVALID",
            "Multipart completion requires every exact part acknowledgement",
          );
        }

        let initialFailed = false;
        let initialError: unknown;
        try {
          await context.race(
            Promise.resolve().then(() => this.#provider.complete(parts, context.signal)),
          );
        } catch (error) {
          if (
            error instanceof ObjectStorageLifecycleError &&
            (error.code === "OBJECT_STORAGE_MULTIPART_ABORTED" ||
              error.code === "OBJECT_STORAGE_MULTIPART_DEADLINE_EXCEEDED")
          ) {
            throw error;
          }
          initialFailed = true;
          initialError = error;
        }

        let receipt = await reconcileCompletedObject({
          backend: this.#backend,
          handle: this.handle,
          context,
        });
        if (!receipt && initialFailed) {
          try {
            await context.race(
              Promise.resolve().then(() => this.#provider.complete(parts, context.signal)),
            );
          } catch (error) {
            if (
              error instanceof ObjectStorageLifecycleError &&
              (error.code === "OBJECT_STORAGE_MULTIPART_ABORTED" ||
                error.code === "OBJECT_STORAGE_MULTIPART_DEADLINE_EXCEEDED")
            ) {
              throw error;
            }
            initialError = error;
          }
          receipt = await reconcileCompletedObject({
            backend: this.#backend,
            handle: this.handle,
            context,
          });
        }
        if (!receipt) {
          if (isNoSuchUpload(initialError)) {
            throw lifecycle(
              "OBJECT_STORAGE_MULTIPART_NO_SUCH_UPLOAD",
              "Multipart upload disappeared before exact completion",
            );
          }
          throw lifecycle(
            "OBJECT_STORAGE_MULTIPART_COMPLETE_UNCONFIRMED",
            "Multipart completion could not be confirmed from exact storage bytes",
            initialError,
          );
        }
        this.#state = "completed";
        this.#completedReceipt = receipt;
        return receipt;
      });
    });
  }

  abort(control: MultipartObjectRequestControl): Promise<void> {
    return this.#enqueue(() => {
      const context = createRequestContext(control);
      return observedOperation(context, async () => {
        context.ensureActive();
        if (this.#state === "completed") {
          throw lifecycle(
            "OBJECT_STORAGE_MULTIPART_INVALID",
            "Completed multipart session cannot be aborted",
          );
        }
        if (this.#state === "aborted") return;
        let firstError: unknown;
        try {
          await context.race(Promise.resolve().then(() => this.#provider.abort(context.signal)));
          this.#state = "aborted";
          return;
        } catch (error) {
          if (
            error instanceof ObjectStorageLifecycleError &&
            (error.code === "OBJECT_STORAGE_MULTIPART_ABORTED" ||
              error.code === "OBJECT_STORAGE_MULTIPART_DEADLINE_EXCEEDED")
          ) {
            throw error;
          }
          if (isNoSuchUpload(error)) {
            this.#state = "aborted";
            return;
          }
          firstError = error;
        }
        try {
          await context.race(Promise.resolve().then(() => this.#provider.abort(context.signal)));
          this.#state = "aborted";
        } catch (error) {
          if (
            error instanceof ObjectStorageLifecycleError &&
            (error.code === "OBJECT_STORAGE_MULTIPART_ABORTED" ||
              error.code === "OBJECT_STORAGE_MULTIPART_DEADLINE_EXCEEDED")
          ) {
            throw error;
          }
          if (isNoSuchUpload(error)) {
            this.#state = "aborted";
            return;
          }
          throw lifecycle(
            "OBJECT_STORAGE_MULTIPART_ABORT_UNCONFIRMED",
            "Multipart abort could not be confirmed by the exact provider handle",
            new AggregateError([firstError, error], "Multipart abort attempts failed"),
          );
        }
      });
    });
  }
}

export function createMultipartSession(input: {
  backend: ExactObjectStorageBackend;
  provider: ProviderMultipartHandle;
  handle: MultipartObjectUploadHandle;
  acknowledgedParts?: readonly MultipartObjectPartReceipt[];
  completedReceipt?: ImmutableObjectUploadReceipt;
}): MultipartObjectUploadSession {
  return Object.freeze(new MultipartObjectUploadSessionImpl(input));
}

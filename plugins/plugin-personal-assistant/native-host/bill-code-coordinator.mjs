import { createHash } from "node:crypto";
import { BillHostError } from "./errors.mjs";

const manual = (message) => ({ kind: "human-verification", message });
const sameOwner = (task, context, taskAccountId) =>
  task.id === context.taskId &&
  task.epoch === context.epoch &&
  task.owner.actorId === context.actorId &&
  task.owner.agentId === context.agentId &&
  task.owner.connector.accountId === taskAccountId;

/** Host-only composition. The reviewed challenge provider never receives passwords. */
export class BillCodeCoordinator {
  #handles = new Map();
  #pending = new Set();
  constructor({
    deriveBillDecision,
    runtime,
    actuator,
    resolver,
    challengeProvider,
    resolveGoogleAccount,
    stillAuthorized = async () => true,
    now = () => Date.now(),
  }) {
    if (typeof deriveBillDecision !== "function")
      throw new BillHostError("Reviewed bill observation policy is required");
    Object.assign(this, {
      deriveBillDecision,
      runtime,
      actuator,
      resolver,
      challengeProvider,
      resolveGoogleAccount,
      stillAuthorized,
      now,
    });
  }
  /** Wire this into NativeTaskActuator.resolveValue; never expose it as a route. */
  async resolveValue(reference, task) {
    const entry = this.#handles.get(reference);
    if (
      !entry ||
      !sameOwner(task, entry.context, entry.taskAccountId) ||
      entry.signal.aborted ||
      !(await this.stillAuthorized())
    )
      throw new BillHostError("Verification value unavailable");
    this.#handles.delete(reference);
    return {
      kind: "verification-code",
      text: await this.resolver.consumeForFill(
        reference,
        entry.context,
        entry.signal,
      ),
    };
  }
  revoke() {
    this.#handles.clear();
    this.resolver.revoke();
  }
  async fill({ taskId, bill, signal = new AbortController().signal }) {
    if (this.#pending.has(taskId))
      return manual("Verification code lookup is already in progress.");
    this.#pending.add(taskId);
    let reference, interrupt, interruptError;
    try {
      signal.throwIfAborted();
      if (!(await this.stillAuthorized()))
        throw new BillHostError("Task authority ended");
      let task = this.runtime.get(taskId);
      if (task.status !== "active" || task.authorization.state !== "active")
        throw new BillHostError("Task is not active");
      await this.runtime.observe(
        taskId,
        task.revision,
        false,
        this.stillAuthorized,
      );
      task = this.runtime.get(taskId);
      const { observation, snapshot } = this.actuator.readObservation(
        taskId,
        this.runtime.owner,
      );
      const decision = this.deriveBillDecision(bill, snapshot);
      if (decision.kind !== "human-verification") return decision;
      // Provider-specific parsing is configured by the host, not supplied by chat/DOM instructions.
      const challenge = await this.challengeProvider({
        bill: structuredClone(bill),
        snapshot: structuredClone(snapshot),
        signal,
      });
      if (!challenge)
        return manual(
          "No supported verification challenge was found. Complete verification on the website yourself.",
        );
      const taskAccountId = task.owner.connector.accountId;
      const googleAccountId = await this.resolveGoogleAccount(task);
      if (typeof googleAccountId !== "string" || !googleAccountId.trim())
        throw new BillHostError("Google account unavailable");
      const context = {
        accountId: googleAccountId,
        actorId: task.owner.actorId,
        agentId: task.owner.agentId,
        taskId,
        epoch: task.epoch,
        providerOrigin: bill.origin,
        recipient: challenge.recipient,
        senders: challenge.senders,
        challengeId: challenge.challengeId,
        issuedAt: challenge.issuedAt,
        expiresAt: challenge.expiresAt,
        searchQuery: challenge.searchQuery,
      };
      if (
        typeof challenge.challengeId !== "string" ||
        !challenge.challengeId ||
        challenge.challengeId.length > 256 ||
        typeof challenge.targetRef !== "string" ||
        snapshot.elements.filter(
          (element) => element.selector === challenge.targetRef,
        ).length !== 1
      )
        throw new BillHostError("Unsupported verification challenge");
      const operationId =
        "code:" +
        createHash("sha256")
          .update(
            JSON.stringify([
              taskId,
              task.epoch,
              bill.origin,
              challenge.challengeId,
            ]),
          )
          .digest("hex");
      if (
        task.operations.some(
          (operation) => operation.proposal.id === operationId,
        )
      )
        return manual(
          "This verification challenge was already handled. Check the code on the website and press Verify yourself, or request a new code there.",
        );
      const result = await this.resolver.resolve(context, signal);
      if (result.status !== "ready") {
        const messages = {
          missing:
            "No matching code was found. Check your email or complete verification yourself.",
          expired:
            "The matching code expired. Request a new code on the website.",
          ambiguous:
            "More than one code matches. Check your email and complete verification yourself.",
          incomplete:
            "The code search could not be completed. Retry later or complete verification yourself.",
        };
        return manual(
          messages[result.status] ||
            "The code is unavailable. Complete verification yourself.",
        );
      }
      reference = result.valueRef;
      const current = this.runtime.get(taskId);
      if (
        signal.aborted ||
        !(await this.stillAuthorized()) ||
        current.revision !== task.revision ||
        !sameOwner(current, context, taskAccountId) ||
        current.status !== "active"
      )
        throw new BillHostError("Task changed during lookup");
      this.#handles.set(reference, { context, signal, taskAccountId });
      interrupt = () => {
        try {
          const active = this.runtime.get(taskId);
          if (
            sameOwner(active, context, taskAccountId) &&
            ["active", "waiting"].includes(active.status)
          )
            this.runtime.control(taskId, active.revision, "pause");
        } catch {
          interruptError = true;
        }
      };
      signal.addEventListener("abort", interrupt, { once: true });
      signal.throwIfAborted();
      const outcome = await this.runtime.execute(taskId, task.revision, {
        id: operationId,
        taskId,
        epoch: task.epoch,
        observationId: observation.id,
        observationVersion: observation.version,
        inputRevision: observation.inputRevision,
        targetRef: challenge.targetRef,
        capability: "browser.fill",
        authorizationId: task.authorization.decisionId,
        expiresAt: Math.min(result.expiresAt, this.now() + 10000),
        valueRef: reference,
      });
      if (interruptError || signal.aborted)
        throw new BillHostError("Code request cancelled");
      return outcome.operations.find(
        (operation) => operation.proposal.id === operationId,
      )?.status === "succeeded"
        ? manual(
            "The matching code was filled. Check it on the website, then press Verify yourself.",
          )
        : manual(
            "Code entry could not be confirmed. Check the website before trying again; Eliza will not press Verify.",
          );
    } catch {
      // Provider messages, parser exceptions and protected values must not escape.
      return manual(
        "The code could not be filled. Check the task and connection, or complete verification on the website yourself.",
      );
    } finally {
      if (interrupt) signal.removeEventListener("abort", interrupt);
      if (reference) this.#handles.delete(reference);
      this.#pending.delete(taskId);
    }
  }
}

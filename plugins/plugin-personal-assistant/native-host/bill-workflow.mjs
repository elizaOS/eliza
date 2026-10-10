import { createHash, randomUUID } from "node:crypto";
import { matchBillControl, validateBillControls } from "./bill-controls.mjs";
import { BillHostError } from "./errors.mjs";

const blocked = (reason) => ({ kind: "blocked", reason });
// Observation selectors are fresh opaque references on each read. Compare the
// facts behind them, then use the new references when guidance is restored.
const policySnapshotKey = (snapshot) =>
  JSON.stringify({
    url: snapshot.url,
    documentId: snapshot.documentId,
    inputRevision: snapshot.inputRevision,
    effectViolation: snapshot.effectViolation,
    text: snapshot.text,
    elements: snapshot.elements.map(
      ({ selector: _selector, ...facts }) => facts,
    ),
  });

async function awaitPolicy(pending, signal) {
  let abort;
  try {
    return await Promise.race([
      pending,
      new Promise((_resolve, reject) => {
        abort = () => reject(new BillHostError("Task authorization changed"));
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
/** Reviewed host policy over shared task/runtime primitives. No agent submit operation exists. */
export class BillWorkflow {
  constructor({
    deriveBillDecision,
    runtime,
    actuator,
    bill,
    taskId,
    outcomes,
    codeCoordinator,
    controls,
    selectionGuidance = null,
    receipts = null,
    stillAuthorized = async () => true,
    signal = new AbortController().signal,
  }) {
    if (typeof deriveBillDecision !== "function")
      throw new BillHostError("Reviewed bill observation policy is required");
    if (
      selectionGuidance !== null &&
      (typeof selectionGuidance !== "object" ||
        Array.isArray(selectionGuidance) ||
        Object.keys(selectionGuidance).join(",") !== "unavailableMessage" ||
        typeof selectionGuidance.unavailableMessage !== "string" ||
        !selectionGuidance.unavailableMessage.trim() ||
        selectionGuidance.unavailableMessage.length > 600)
    )
      throw new BillHostError("Invalid required selection guidance policy");
    Object.assign(this, {
      selectionGuidance: structuredClone(selectionGuidance),
      deriveBillDecision,
      runtime,
      actuator,
      bill: structuredClone(bill),
      taskId,
      outcomes,
      codeCoordinator,
      stillAuthorized,
      signal,
      receipts,
      controls: validateBillControls(controls),
    });
  }
  /**
   * A saved outcome says "Receipt available in your email" only after one
   * matching receipt email was found. The search runs at most three times,
   * a minute apart, because a receipt can arrive late. A failed search is
   * not a missing receipt and never changes the payment outcome.
   */
  async withReceipt(outcome) {
    if (
      outcome?.kind !== "outcome" ||
      outcome.saveStatus !== "saved" ||
      typeof this.receipts?.find !== "function" ||
      typeof this.outcomes?.loadReceiptCheck !== "function" ||
      typeof this.outcomes?.beginReceiptCheck !== "function" ||
      typeof this.outcomes?.confirmReceiptCheck !== "function"
    )
      return outcome;
    let check = this.outcomes.loadReceiptCheck();
    if (
      !check?.found &&
      (check?.checks ?? 0) < 3 &&
      Date.now() - (check?.checkedAt ?? 0) >= 60000
    )
      try {
        const attempt = this.outcomes.beginReceiptCheck();
        if (!attempt) return outcome;
        check = attempt;
        const found = await this.receipts.find(
          {
            reference: outcome.reference,
            observedAt: outcome.observedAt,
          },
          this.signal,
        );
        if (found === true) check = this.outcomes.confirmReceiptCheck();
      } catch {
        // The reserved attempt remains counted; a later look may retry.
      }
    return check?.found ? { ...outcome, receiptInEmail: true } : outcome;
  }
  async clearGuidance() {
    await this.actuator.quiesce?.({
      owner: this.runtime.owner,
      taskId: this.taskId,
    });
  }
  hasPaymentHistory() {
    return Boolean(
      this.outcomes?.loadAttempt?.() ||
        this.outcomes?.hasPriorPayment?.(this.bill),
    );
  }
  async guide(decision, snapshot, restore) {
    const keys = {
      "human-sign-in": "signIn",
      "human-verification": "verification",
      "human-submit": "submit",
      "choose-existing-method": "existingMethod",
    };
    const control = this.controls[keys[decision.kind]];
    if (!control) {
      await this.clearGuidance();
      return decision;
    }
    const instruction =
      decision.message ||
      "Review the existing payment method on the website before choosing it in Eliza.";
    const guidance = { instruction, available: false };
    const unavailable = () =>
      this.selectionGuidance && decision.kind === "choose-existing-method"
        ? {
            kind: "human-review",
            message: this.selectionGuidance.unavailableMessage,
            guidance,
          }
        : { ...decision, guidance };
    const target = matchBillControl(snapshot, control);
    if (!target || !this.actuator.showGuidance) {
      await this.clearGuidance();
      return unavailable();
    }
    if (!(await this.stillAuthorized()) || this.signal.aborted) {
      await this.clearGuidance();
      throw new BillHostError("Task authorization changed");
    }
    try {
      const shown = await this.actuator.showGuidance(
        this.taskId,
        this.runtime.owner,
        {
          stepId: `bill:${decision.kind}`,
          targetRef: target.selector,
          text: instruction,
          restore,
        },
        this.signal,
      );
      if (!(await this.stillAuthorized()))
        throw new BillHostError("Task authorization changed");
      return {
        ...decision,
        guidance: {
          instruction,
          available: true,
          // The renderer checks the website again before the guide expires.
          ...(Number.isSafeInteger(shown?.expiresAt)
            ? { expiresAt: shown.expiresAt }
            : {}),
        },
      };
    } catch {
      // Preserve the instruction; failed removal still fails the whole request.
      await this.clearGuidance();
      if (!(await this.stillAuthorized()) || this.signal.aborted)
        throw new BillHostError("Task authorization changed");
      return unavailable();
    }
  }
  async refresh(options = {}) {
    try {
      return await this.refreshObserved(options);
    } catch (error) {
      await this.clearGuidance();
      throw error;
    }
  }
  /** The kept record of a payment the website showed before this task paid. */
  priorOutcome(record) {
    // A kept record whose task could not be ended yet is ended now.
    let ended = true;
    try {
      this.outcomes.endPriorTask?.();
    } catch {
      ended = false;
    }
    return {
      kind: "prior-outcome",
      status: record.status,
      ...(record.reference !== undefined
        ? { reference: record.reference }
        : {}),
      source: record.source,
      message: record.message,
      ended,
    };
  }
  async refreshObserved({ restoreGuidance = false, skipCode = false } = {}) {
    if (this.outcomes?.load()) {
      await this.clearGuidance();
      return this.withReceipt(this.outcomes.retry());
    }
    const prior = this.outcomes?.loadPriorOutcome?.();
    if (prior) {
      await this.clearGuidance();
      return this.priorOutcome(prior);
    }
    const task = this.runtime.get(this.taskId);
    if (task.status === "paused") {
      await this.clearGuidance();
      return { kind: "paused", taskId: this.taskId };
    }
    if (task.operations.some((operation) => operation.status === "unknown")) {
      await this.clearGuidance();
      return {
        kind: "unknown-outcome",
        message: "Check the previous action before continuing.",
      };
    }
    if (task.status !== "active") {
      await this.clearGuidance();
      return {
        kind: "unavailable",
        message: "This task cannot currently observe the website.",
      };
    }
    try {
      await this.runtime.observe(
        task.id,
        task.revision,
        false,
        this.stillAuthorized,
      );
    } catch (error) {
      await this.clearGuidance();
      if (!(await this.stillAuthorized()) || this.signal.aborted) throw error;
      if (this.hasPaymentHistory())
        return {
          kind: "unknown-outcome",
          message:
            "A submission or outcome was previously observed for this bill, but its current status cannot be checked now. Check the provider status before considering another payment.",
        };
      throw error;
    }
    let { observation, snapshot } = this.actuator.readObservation(
      task.id,
      this.runtime.owner,
    );
    // The browser stopped a submit or page change that a task action set
    // off. Stop here; the person checks the website before going on.
    if (snapshot.effectViolation !== undefined) {
      await this.clearGuidance();
      if (!(await this.stillAuthorized()) || this.signal.aborted)
        throw new BillHostError("Task authorization changed");
      const current = this.runtime.get(task.id);
      if (["active", "waiting"].includes(current.status)) {
        this.runtime.control(current.id, current.revision, "pause");
        await this.runtime.settle?.(current.id);
      }
      return {
        kind: "paused",
        taskId: this.taskId,
        message:
          "The website tried to submit or leave the page after my last step. I paused the task. Check the website to confirm what happened before resuming.",
      };
    }
    const { epoch: policyEpoch, revision: policyRevision } = this.runtime.get(
      this.taskId,
    );
    const snapshotKey = policySnapshotKey(snapshot);
    let decision = this.deriveBillDecision(this.bill, snapshot, {
      signal: this.signal,
      taskId: this.taskId,
      epoch: policyEpoch,
    });
    if (decision && typeof decision.then === "function") {
      decision = await awaitPolicy(decision, this.signal);
      if (!(await this.stillAuthorized()) || this.signal.aborted)
        throw new BillHostError("Task authorization changed");
      const current = this.runtime.get(this.taskId);
      if (
        current.status !== "active" ||
        current.epoch !== policyEpoch ||
        current.revision !== policyRevision
      ) {
        await this.clearGuidance();
        return blocked(
          "The task changed while the bill was being checked. Check it again.",
        );
      }
      await this.runtime.observe(
        current.id,
        current.revision,
        false,
        this.stillAuthorized,
      );
      const fresh = this.actuator.readObservation(
        this.taskId,
        this.runtime.owner,
      );
      if (!(await this.stillAuthorized()) || this.signal.aborted)
        throw new BillHostError("Task authorization changed");
      const observedTask = this.runtime.get(this.taskId);
      if (
        observedTask.status !== "active" ||
        observedTask.epoch !== policyEpoch
      ) {
        await this.clearGuidance();
        return blocked(
          "The task changed while the bill was being checked. Check it again.",
        );
      }
      // The browser stopped a submit or page change that a task action set
      // off. Stop here; the person checks the website before going on.
      if (fresh.snapshot.effectViolation !== undefined) {
        await this.clearGuidance();
        if (!(await this.stillAuthorized()) || this.signal.aborted)
          throw new BillHostError("Task authorization changed");
        const current = this.runtime.get(task.id);
        if (["active", "waiting"].includes(current.status)) {
          this.runtime.control(current.id, current.revision, "pause");
          await this.runtime.settle?.(current.id);
        }
        return {
          kind: "paused",
          taskId: this.taskId,
          message:
            "The website tried to submit or leave the page after my last step. I paused the task. Check the website to confirm what happened before resuming.",
        };
      }
      if (snapshotKey !== policySnapshotKey(fresh.snapshot)) {
        await this.clearGuidance();
        return blocked(
          "The website changed while the bill was being checked. Check it again.",
        );
      }
      ({ observation, snapshot } = fresh);
    }
    if (
      !decision ||
      typeof decision !== "object" ||
      typeof decision.kind !== "string"
    )
      throw new BillHostError("Invalid bill observation decision");
    if (decision.kind === "outcome") {
      await this.clearGuidance();
      if (!(await this.stillAuthorized()))
        return blocked("Task authorization changed.");
      // The website already shows this bill paid or scheduled, but this task
      // neither reviewed nor submitted a payment and saved no outcome. It is
      // not this task's payment when no task submitted one, or when an earlier
      // task already saved its outcome: that payment is the earlier task's
      // record. Only an earlier submission still waiting for its outcome is
      // finished here.
      const ownHistory =
        typeof this.outcomes?.load === "function" &&
        typeof this.outcomes?.loadReview === "function" &&
        typeof this.outcomes?.loadAttempt === "function"
          ? Boolean(
              this.outcomes.load() ||
                this.outcomes.loadReview() ||
                this.outcomes.loadAttempt(),
            )
          : true;
      const earlierOutcome = Boolean(
        this.outcomes?.hasPriorOutcome?.(this.bill),
      );
      if (!ownHistory && (earlierOutcome || !this.hasPaymentHistory())) {
        const prior = {
          kind: "prior-outcome",
          status: decision.status,
          ...(typeof decision.reference === "string"
            ? { reference: decision.reference }
            : {}),
          source: decision.source,
          message:
            (decision.status === "scheduled"
              ? "The website shows this bill is already scheduled."
              : "The website shows this bill is already paid.") +
            (earlierOutcome
              ? " An earlier task already recorded a payment for this bill."
              : "") +
            " This task did not review a payment, so it is not saved as this task's payment. Check the website's records before you pay again.",
        };
        // Nothing is left to do for this bill: keep the fact and end the task.
        // If the record cannot be kept, the task stays open and says so.
        if (!this.outcomes?.recordPriorOutcome) return prior;
        let record;
        try {
          record = this.outcomes.recordPriorOutcome(
            { ...prior, billSource: this.bill.sourceRef, earlierOutcome },
            observation.id,
          );
        } catch {
          record = this.outcomes.loadPriorOutcome?.();
          if (!record) return { ...prior, ended: false };
        }
        return this.priorOutcome(record);
      }
      return this.outcomes
        ? this.withReceipt(
            this.outcomes.save(
              { ...decision, company: this.bill.company },
              observation.id,
            ),
          )
        : {
            ...decision,
            saveStatus: "pending",
            message:
              "The website outcome was observed, but local outcome storage is not connected.",
          };
    }
    if (decision.kind === "submission-pending") {
      await this.clearGuidance();
      if (!(await this.stillAuthorized()) || this.signal.aborted)
        throw new BillHostError("Task authorization changed");
      if (!this.outcomes?.recordSubmission)
        return {
          kind: "unknown-outcome",
          message:
            "The website shows a submission, but its local record is unavailable. Check the provider status; do not submit another payment.",
        };
      try {
        this.outcomes.recordSubmission(decision, observation.id);
      } catch {
        return {
          kind: "unknown-outcome",
          message:
            "The website shows a submission, but saving its local record failed. Check the provider status; do not submit another payment.",
        };
      }
      return decision;
    }
    const previousReview = this.outcomes?.loadReview?.();
    if (
      previousReview &&
      (previousReview.review.billSource !== this.bill.sourceRef ||
        new URL(previousReview.source).origin !== this.bill.origin)
    ) {
      await this.clearGuidance();
      return blocked(
        "The saved payment review belongs to a different bill. Check the original task before continuing.",
      );
    }
    const activity = snapshot.manualActivity;
    if (
      activity &&
      (!Array.isArray(activity.events) ||
        activity.events.length > 256 ||
        activity.events.some(
          (event) =>
            !event ||
            event.kind !== "form-submit" ||
            typeof event.origin !== "string" ||
            typeof event.documentId !== "string" ||
            !Number.isSafeInteger(event.epoch) ||
            !Number.isSafeInteger(event.observedAt) ||
            (event.credential !== undefined && event.credential !== true),
        ) ||
        typeof activity.overflow !== "boolean" ||
        typeof activity.captureGap !== "boolean")
    ) {
      await this.clearGuidance();
      throw new BillHostError("Invalid manual activity evidence");
    }
    // No payment was reviewed, but the website was hers for a while (the
    // task was paused or restarted since). A form she sent on the biller's
    // website then, other than a sign-in or code form, may be a payment.
    // Check its status instead of preparing another payment.
    if (
      !previousReview &&
      activity &&
      this.outcomes?.recordSubmission &&
      !["human-sign-in", "human-verification"].includes(decision.kind) &&
      (activity.overflow ||
        activity.captureGap ||
        activity.events.some(
          (event) =>
            event.credential !== true &&
            event.origin === this.bill.origin &&
            event.epoch < task.epoch,
        ))
    ) {
      await this.clearGuidance();
      if (!(await this.stillAuthorized()) || this.signal.aborted)
        throw new BillHostError("Task authorization changed");
      const source = new URL(snapshot.url);
      source.search = "";
      source.hash = "";
      try {
        this.outcomes.recordSubmission(
          {
            kind: "submission-uncertain",
            source: source.href,
            billSource: this.bill.sourceRef,
          },
          observation.id,
        );
      } catch {
        return {
          kind: "unknown-outcome",
          message:
            "Payment activity may have occurred, but its local record could not be saved. Check the provider status; do not submit another payment.",
        };
      }
      return {
        kind: "unknown-outcome",
        message:
          "A form was sent on this website while it was yours. This does not confirm a payment. Check the provider status before trying again.",
      };
    }
    if (previousReview && activity) {
      const submission = activity.events.some(
        (event) =>
          event.kind === "form-submit" &&
          event.origin === this.bill.origin &&
          event.documentId === previousReview.documentId &&
          event.epoch === previousReview.epoch &&
          Number.isSafeInteger(event.observedAt) &&
          event.observedAt >= previousReview.observedAt,
      );
      if (submission || activity.overflow || activity.captureGap) {
        await this.clearGuidance();
        if (!(await this.stillAuthorized()) || this.signal.aborted)
          throw new BillHostError("Task authorization changed");
        const uncertain = {
          kind: "submission-uncertain",
          source: previousReview.source,
          billSource: this.bill.sourceRef,
        };
        try {
          this.outcomes.recordSubmission(uncertain, observation.id);
        } catch {
          return {
            kind: "unknown-outcome",
            message:
              "Payment activity may have occurred, but its local record could not be saved. Check the provider status; do not submit another payment.",
          };
        }
        return {
          kind: "unknown-outcome",
          message:
            "There was form activity or a gap in observation after payment review. This does not confirm a payment. Check the provider status before trying again.",
        };
      }
    }
    if (this.hasPaymentHistory()) {
      await this.clearGuidance();
      return {
        kind: "unknown-outcome",
        message:
          "A submission or outcome was previously observed for this bill. Check the provider status before considering another payment.",
      };
    }
    if (
      decision.kind === "human-verification" &&
      this.codeCoordinator &&
      !skipCode
    ) {
      await this.clearGuidance();
      const codeResult = await this.codeCoordinator.fill({
        taskId: this.taskId,
        bill: this.bill,
        signal: this.signal,
      });
      // A filled field is not successful verification. Re-observe without
      // recursively starting another lookup before restoring human guidance.
      const current = await this.refreshObserved({
        restoreGuidance,
        skipCode: true,
      });
      if (
        current.kind !== "human-verification" ||
        codeResult.kind !== "human-verification"
      )
        return current;
      const after = this.actuator.readObservation(
        this.taskId,
        this.runtime.owner,
      ).snapshot;
      return this.guide(
        {
          ...current,
          message: codeResult.message,
          ...(codeResult.codeReason
            ? { codeReason: codeResult.codeReason }
            : {}),
        },
        after,
        restoreGuidance,
      );
    }
    if (decision.reviewKey)
      decision.reviewKey = createHash("sha256")
        .update(
          JSON.stringify([
            decision.reviewKey,
            task.id,
            task.epoch,
            snapshot.documentId,
            snapshot.inputRevision,
          ]),
        )
        .digest("hex");
    if (decision.kind === "human-submit" && this.outcomes?.recordReview) {
      if (!(await this.stillAuthorized()) || this.signal.aborted) {
        await this.clearGuidance();
        throw new BillHostError("Task authorization changed");
      }
      try {
        this.outcomes.recordReview(
          decision,
          observation.id,
          snapshot,
          task.epoch,
        );
      } catch (error) {
        await this.clearGuidance();
        throw error;
      }
    }
    return this.guide(decision, snapshot, restoreGuidance);
  }
  /** Explicit choice commit, after a fresh observation. It selects a saved method only. */
  async chooseExistingMethod(
    expectedReviewKey,
    {
      operationId = randomUUID(),
      isCurrent = () => true,
      relocated = false,
    } = {},
  ) {
    const decision = await this.refresh();
    if (decision.kind !== "choose-existing-method") {
      if (
        this.selectionGuidance &&
        decision.kind === "human-review" &&
        decision.guidance?.available === false
      ) {
        if (
          !isCurrent() ||
          !(await this.stillAuthorized()) ||
          this.signal.aborted
        )
          return blocked("Task authorization changed.");
        const current = this.runtime.get(this.taskId);
        if (current.status === "active") {
          // The offered choice is consumed even though no effect was dispatched.
          // Pause advances its epoch; explicit Resume can offer a fresh choice.
          this.runtime.control(current.id, current.revision, "pause");
          await this.runtime.settle(current.id);
        }
      }
      return decision;
    }
    if (decision.reviewKey !== expectedReviewKey)
      return {
        ...decision,
        message: "Review the current details before choosing this method.",
      };
    const task = this.runtime.get(this.taskId);
    const { observation, snapshot } = this.actuator.readObservation(
      task.id,
      this.runtime.owner,
    );
    const target = matchBillControl(snapshot, this.controls.existingMethod);
    if (!target)
      return blocked("The existing-method control is not unambiguous.");
    if (!isCurrent() || !(await this.stillAuthorized()))
      return blocked("Task authorization changed.");
    const proposal = {
      id: operationId,
      taskId: task.id,
      epoch: task.epoch,
      observationId: observation.id,
      observationVersion: observation.version,
      inputRevision: observation.inputRevision,
      targetRef: target.selector,
      capability: "browser.click",
      authorizationId: task.authorization.decisionId,
      expiresAt: Date.now() + 10000,
    };
    if (!this.outcomes?.recordMethodSelection) {
      await this.clearGuidance();
      return blocked("Durable method selection storage is unavailable.");
    }
    try {
      this.outcomes.recordMethodSelection(decision, proposal, snapshot);
    } catch {
      await this.clearGuidance();
      return blocked(
        "The reviewed method could not be saved. No selection was sent.",
      );
    }
    const result = await this.runtime.execute(task.id, task.revision, proposal);
    const operation = result.operations.find(
      (operation) => operation.proposal.id === operationId,
    );
    const status = operation?.status;
    // Retry only an explicit pre-effect refusal. A verified failure after a
    // click is not evidence that repeating the click is safe.
    if (status === "failed" && operation.evidenceRef === "not-dispatched") {
      if (!relocated)
        return this.chooseExistingMethod(expectedReviewKey, {
          operationId: `${operationId}.relocated`,
          isCurrent,
          relocated: true,
        });
      return blocked(
        "The saved payment method was not selected. No click was sent.",
      );
    }
    if (status !== "succeeded")
      return {
        kind: "unknown-outcome",
        message:
          "Method selection was not verified. Check the website before continuing.",
      };
    return this.refresh();
  }
}

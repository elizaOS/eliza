import { createHash, randomUUID } from "node:crypto";
import { matchBillControl, validateBillControls } from "./bill-controls.mjs";
import { BillHostError } from "./errors.mjs";
import { GuidedWebsiteWorkflow } from "./guided-website-workflow.mjs";

/** Fixed workflow words carry a `reasonCode`, so a host never matches the words. */
const blocked = (reason, reasonCode) => ({
  kind: "blocked",
  reason,
  reasonCode,
});
const unknownOutcome = (reasonCode, message) => ({
  kind: "unknown-outcome",
  reasonCode,
  message,
});
const personGuidance = (kind) =>
  [
    "human-review",
    "human-sign-in",
    "human-verification",
    "human-submit",
  ].includes(kind);
/**
 * The bill configuration of the guided website workflow: reviewed host policy
 * decides each step, and payment reviews, submissions and outcomes are kept
 * as durable evidence. No agent submit operation exists.
 */
export class BillWorkflow extends GuidedWebsiteWorkflow {
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
    assistantName = "Eliza",
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
    if (
      typeof assistantName !== "string" ||
      !assistantName.trim() ||
      assistantName.length > 64
    )
      throw new BillHostError("Invalid assistant name");
    super({ runtime, actuator, taskId, stillAuthorized, signal });
    Object.assign(this, {
      selectionGuidance: structuredClone(selectionGuidance),
      deriveBillDecision,
      bill: structuredClone(bill),
      outcomes,
      codeCoordinator,
      receipts,
      assistantName,
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
      // A receipt is matched by its reference; without one no lookup is spent.
      typeof outcome.reference !== "string" ||
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
    const discovered =
      personGuidance(decision.kind) && decision.guidanceTarget !== undefined;
    if (!control && !discovered) {
      await this.clearGuidance();
      return decision;
    }
    const instruction =
      decision.message ||
      `Review the existing payment method on the website before choosing it in ${this.assistantName}.`;
    const matches = discovered
      ? snapshot.elements.filter(
          (element) => element.selector === decision.guidanceTarget,
        )
      : [];
    const target = discovered
      ? matches.length === 1
        ? matches[0]
        : null
      : matchBillControl(snapshot, control);
    return this.pointAt(decision, target, {
      stepId: `bill:${decision.kind}`,
      instruction,
      restore,
      unavailable: (guidance) =>
        this.selectionGuidance && decision.kind === "choose-existing-method"
          ? {
              kind: "human-review",
              message: this.selectionGuidance.unavailableMessage,
              guidance,
            }
          : { ...decision, guidance },
    });
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
    const gate = await this.taskGate();
    if (gate.result) return gate.result;
    const { task } = gate;
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
        return unknownOutcome(
          "status-unavailable",
          "A submission or outcome was previously observed for this bill, but its current status cannot be checked now. Check the provider status before considering another payment.",
        );
      throw error;
    }
    const read = this.actuator.readObservation(task.id, this.runtime.owner);
    if (read.snapshot.effectViolation !== undefined)
      return this.pauseForEffectViolation();
    const decided = await this.decideOnFreshPage(
      read,
      (snapshot, context) =>
        this.deriveBillDecision(this.bill, snapshot, context),
      {
        taskChanged:
          "The task changed while the bill was being checked. Check it again.",
        pageChanged:
          "The website changed while the bill was being checked. Check it again.",
      },
    );
    if (decided.result) return decided.result;
    const { decision, observation, snapshot } = decided;
    if (
      !decision ||
      typeof decision !== "object" ||
      typeof decision.kind !== "string"
    )
      throw new BillHostError("Invalid bill observation decision");
    if (decision.kind === "outcome") {
      await this.clearGuidance();
      if (!(await this.stillAuthorized()))
        return blocked("Task authorization changed.", "authorization-changed");
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
            reasonCode: "outcome-storage-unavailable",
            message:
              "The website outcome was observed, but local outcome storage is not connected.",
          };
    }
    if (decision.kind === "submission-pending") {
      await this.clearGuidance();
      if (!(await this.stillAuthorized()) || this.signal.aborted)
        throw new BillHostError("Task authorization changed");
      if (!this.outcomes?.recordSubmission)
        return unknownOutcome(
          "submission-storage-unavailable",
          "The website shows a submission, but its local record is unavailable. Check the provider status; do not submit another payment.",
        );
      try {
        this.outcomes.recordSubmission(decision, observation.id);
      } catch {
        return unknownOutcome(
          "submission-save-failed",
          "The website shows a submission, but saving its local record failed. Check the provider status; do not submit another payment.",
        );
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
        "review-other-bill",
      );
    }
    const activity = await this.manualActivity(snapshot);
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
        return unknownOutcome(
          "activity-save-failed",
          "Payment activity may have occurred, but its local record could not be saved. Check the provider status; do not submit another payment.",
        );
      }
      return unknownOutcome(
        "manual-submit",
        "A form was sent on this website while it was yours. This does not confirm a payment. Check the provider status before trying again.",
      );
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
          return unknownOutcome(
            "activity-save-failed",
            "Payment activity may have occurred, but its local record could not be saved. Check the provider status; do not submit another payment.",
          );
        }
        return unknownOutcome(
          "activity-after-review",
          "There was form activity or a gap in observation after payment review. This does not confirm a payment. Check the provider status before trying again.",
        );
      }
    }
    if (this.hasPaymentHistory()) {
      await this.clearGuidance();
      return unknownOutcome(
        "prior-payment",
        "A submission or outcome was previously observed for this bill. Check the provider status before considering another payment.",
      );
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
          return blocked(
            "Task authorization changed.",
            "authorization-changed",
          );
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
        reasonCode: "review-changed",
        message: "Review the current details before choosing this method.",
      };
    const task = this.runtime.get(this.taskId);
    const { observation, snapshot } = this.actuator.readObservation(
      task.id,
      this.runtime.owner,
    );
    const target = matchBillControl(snapshot, this.controls.existingMethod);
    if (!target)
      return blocked(
        "The existing-method control is not unambiguous.",
        "method-control-ambiguous",
      );
    if (!isCurrent() || !(await this.stillAuthorized()))
      return blocked("Task authorization changed.", "authorization-changed");
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
      return blocked(
        "Durable method selection storage is unavailable.",
        "selection-storage-unavailable",
      );
    }
    try {
      this.outcomes.recordMethodSelection(decision, proposal, snapshot);
    } catch {
      await this.clearGuidance();
      return blocked(
        "The reviewed method could not be saved. No selection was sent.",
        "selection-save-failed",
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
        "selection-not-sent",
      );
    }
    if (status !== "succeeded")
      return unknownOutcome(
        "selection-unverified",
        "Method selection was not verified. Check the website before continuing.",
      );
    return this.refresh();
  }
}

import { createHash, randomUUID } from "node:crypto";
import { BillHostError } from "./errors.mjs";

/** Prefix of the proposal ID of a fill the person agreed to. */
export const GUIDED_FILL = "guided-fill:";

const blocked = (reason) => ({ kind: "blocked", reason });
const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/**
 * Observation selectors are fresh opaque references on each read. Compare the
 * facts behind them, then use the new references when guidance is restored.
 */
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

/** Waits for host policy, but stops when the task's authority ends. */
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

// The facts that identify one control on a page, in the order a person reads
// them. Two reads of an unchanged page give each control the same ref.
const LOCATING_FACTS = [
  "tag",
  "role",
  "type",
  "label",
  "placeholder",
  "title",
  "fieldName",
  "imageText",
  "nearbyText",
  "rowText",
  "group",
];
const FIELD_ROLES = [
  "textbox",
  "searchbox",
  "combobox",
  "spinbutton",
  "slider",
];
const CHOICE_ROLES = [
  "checkbox",
  "radio",
  "switch",
  "option",
  "tab",
  "menuitemcheckbox",
  "menuitemradio",
];
const BUTTON_TYPES = ["button", "submit", "reset", "image"];
// Input types the browser's task fill accepts (packages/os/browser).
const FILL_TYPES = [
  null,
  "",
  "text",
  "email",
  "tel",
  "number",
  "search",
  "url",
  "date",
];

function controlKind(element) {
  if (element.tag === "input" && ["checkbox", "radio"].includes(element.type))
    return "choice";
  if (CHOICE_ROLES.includes(element.role)) return "choice";
  if (
    (element.tag === "input" && !BUTTON_TYPES.includes(element.type)) ||
    ["textarea", "select"].includes(element.tag) ||
    FIELD_ROLES.includes(element.role) ||
    typeof element.hasInput === "boolean"
  )
    return "field";
  if (element.tag === "a" || element.role === "link") return "link";
  return "button";
}

/**
 * Every control of one complete observation, with a stable ref for each. A
 * ref is made from the facts that locate the control (role, name, label,
 * placeholder, title, field name, image text, nearby text, field group and
 * form), so a control with no usable name still gets one, and repeated names
 * are told apart by their nearby text. Fields that hold a secret (password,
 * code, card, bank or ID number) are kept apart in `protectedFields`; their
 * words never reach a model and they are never filled.
 */
export function pageControls(snapshot) {
  const controls = [];
  const protectedFields = [];
  const seen = new Map();
  snapshot.elements.forEach((element, index) => {
    if (typeof element.sensitive === "string") {
      protectedFields.push({ index, element, category: element.sensitive });
      return;
    }
    const facts = [
      ...LOCATING_FACTS.map((key) => element[key] ?? null),
      element.form?.index ?? null,
    ];
    const base = `c${digest(facts).slice(0, 10)}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    controls.push({
      ref: count ? `${base}.${count}` : base,
      index,
      kind: controlKind(element),
      element,
    });
  });
  return { controls, protectedFields };
}

const present = (entries) =>
  Object.fromEntries(
    entries.filter(([, value]) => value !== null && value !== undefined),
  );

/**
 * The page as a model may read it: the address without its query, the title,
 * the visible text and each control's locating facts, state and position.
 * Selectors, field values and the words of protected fields are not in it.
 * Everything in it was written by the website: it is data, not instructions.
 */
export function pageView(snapshot, { controls, protectedFields }) {
  const url = new URL(snapshot.url);
  return {
    url: `${url.origin}${url.pathname}`,
    title: snapshot.title ?? "",
    text: snapshot.text,
    controls: controls.map(({ ref, kind, element }) =>
      present([
        ["ref", ref],
        ["kind", kind],
        ["role", element.role],
        ["type", element.type],
        ["label", element.label || null],
        ["placeholder", element.placeholder],
        ["title", element.title],
        ["fieldName", element.fieldName],
        ["imageText", element.imageText],
        ["nearbyText", element.nearbyText],
        ["rowText", element.rowText],
        ["group", element.group],
        [
          "form",
          element.form
            ? (element.form.name ?? `form ${element.form.index + 1}`)
            : null,
        ],
        ["description", element.description],
        [
          "filled",
          typeof element.hasInput === "boolean"
            ? element.hasInput
            : typeof element.checked === "boolean"
              ? element.checked
              : null,
        ],
        ["edited", element.edited === true ? true : null],
        ["required", element.required === true ? true : null],
        ["invalid", element.invalid === true ? true : null],
        ["expanded", element.expanded],
        ["disabled", element.disabled === true ? true : null],
        ["submits", element.submits === true ? true : null],
        ["pressable", element.pressable],
        ["inViewport", element.inViewport],
        [
          "position",
          element.bounds
            ? {
                x: Math.round(element.bounds.x),
                y: Math.round(element.bounds.y),
                width: Math.round(element.bounds.width),
                height: Math.round(element.bounds.height),
              }
            : null,
        ],
        ["href", element.href],
      ]),
    ),
    protectedFields: protectedFields.map(({ element, category }) =>
      present([
        ["category", category],
        ["filled", element.hasInput === true],
        [
          "form",
          element.form
            ? (element.form.name ?? `form ${element.form.index + 1}`)
            : null,
        ],
      ]),
    ),
  };
}

/** Whether the browser's task fill can set this field, and nobody has typed in it. */
const offerableField = (control, controls) =>
  control.kind === "field" &&
  control.element.disabled !== true &&
  control.element.hasInput !== true &&
  control.element.edited !== true &&
  ((control.element.tag === "input" &&
    FILL_TYPES.includes(control.element.type ?? null)) ||
    ["textarea", "select"].includes(control.element.tag)) &&
  typeof control.element.targetSelector === "string" &&
  controls.filter(
    (other) => other.element.targetSelector === control.element.targetSelector,
  ).length === 1;

/**
 * Host verification of an agreed fill: the same field, by its selector, now
 * has input, on the same document. A fill receipt alone is not this proof.
 */
export function verifyGuidedFill(proposal, before, after) {
  if (!proposal.id.startsWith(GUIDED_FILL)) return "unknown";
  const field = (snapshot) =>
    snapshot.elements.filter(
      (element) => element.targetSelector === proposal.expectedSelector,
    );
  const [was] = field(before);
  const now = field(after);
  if (
    !was ||
    after.documentId !== before.documentId ||
    after.effectViolation !== undefined ||
    now.length !== 1
  )
    return "unknown";
  return now[0].hasInput === true && typeof now[0].sensitive !== "string"
    ? "succeeded"
    : "failed";
}

const DEFAULT_WORDS = {
  password: "Type your password here yourself. I cannot see it.",
  "one-time-code": "Type the code you were sent here yourself.",
  "payment-card":
    "Type your card details here yourself. I never see or fill them.",
  "bank-account":
    "Type your bank details here yourself. I never see or fill them.",
  "government-id": "Type this ID number here yourself. I never see or fill it.",
  manualActivity:
    "A form was sent on this website while it was yours. Check what it did, then tell me to go on.",
  effectViolation:
    "The website tried to submit or leave the page after my last step. I paused the task. Check the website to confirm what happened before resuming.",
  changed:
    "The website changed while I was checking it. Let me look at it again.",
  noTarget:
    "I could not match the next step to one control on this page. Nothing was pressed.",
  notSent: "Nothing was filled in. Check the box on the website again.",
  notFilled: "That box was not filled in. Check it on the website.",
  fillUnknown:
    "I could not check that box after filling it in. Check the website before you go on.",
};
const PROTECTED_KIND = {
  password: "human-sign-in",
  "one-time-code": "human-verification",
};
const STATUSES = ["act", "wait", "done", "blocked", "needs-help"];
// Manual activity is browser-reported evidence; a malformed record stops the task.
function validManualActivity(activity) {
  return (
    Array.isArray(activity.events) &&
    activity.events.length <= 256 &&
    activity.events.every(
      (event) =>
        event &&
        event.kind === "form-submit" &&
        typeof event.origin === "string" &&
        typeof event.documentId === "string" &&
        Number.isSafeInteger(event.epoch) &&
        Number.isSafeInteger(event.observedAt) &&
        (event.credential === undefined || event.credential === true),
    ) &&
    typeof activity.overflow === "boolean" &&
    typeof activity.captureGap === "boolean"
  );
}

/**
 * Guides the person through any website, one step at a time, over the shared
 * task runtime and native browser actuator. Each step is read from a fresh
 * observation: the host planner (`planStep`) sees only `pageView`, picks one
 * control by its ref, and the workflow points at it. The person presses every
 * control herself. The only effect the workflow can cause is one fill of a
 * value the host holds, into one empty ordinary field, after she agrees
 * (`fill`). It re-reads the page before and after that fill.
 *
 * It stops and asks when the website did something nobody asked for (a form
 * sent while the website was hers, or a submit or page change after a task
 * step), and when the host's `checkStep` says the step needs her word first.
 * Bills are one configuration of this workflow (`BillWorkflow`).
 */
export class GuidedWebsiteWorkflow {
  constructor({
    runtime,
    actuator,
    taskId,
    planStep,
    checkStep = null,
    words = {},
    stillAuthorized = async () => true,
    signal = new AbortController().signal,
  }) {
    if (new.target === GuidedWebsiteWorkflow && typeof planStep !== "function")
      throw new BillHostError("A website step planner is required");
    Object.assign(this, {
      runtime,
      actuator,
      taskId,
      planStep,
      checkStep,
      stillAuthorized,
      signal,
      words: { ...DEFAULT_WORDS, ...words },
    });
    this.acknowledged = new Set();
    this.history = [];
    this.lastStep = null;
    this.offer = null;
    this.grant = null;
  }
  /**
   * The one fill target the person agreed to, for the host's browser policy
   * (`NativeTaskActuator` `policy`). The browser accepts a changed target
   * only under a new task epoch, so the grant belongs to the epoch that
   * `fill` started for it and ends with that epoch.
   */
  fillTargets(task) {
    return this.grant && this.grant.epoch === task.epoch
      ? [{ selector: this.grant.selector, action: "fill" }]
      : [];
  }
  /** The person answered a stop-and-ask question; the same question is not asked again. */
  acknowledge(key) {
    this.acknowledged.add(key);
  }
  async clearGuidance() {
    await this.actuator.quiesce?.({
      owner: this.runtime.owner,
      taskId: this.taskId,
    });
  }
  async requireAuthority() {
    if (!(await this.stillAuthorized()) || this.signal.aborted) {
      await this.clearGuidance();
      throw new BillHostError("Task authorization changed");
    }
  }
  /**
   * The browser stopped a submit or page change that a task action set off.
   * Pause; the person checks the website before going on.
   */
  async pauseForEffectViolation() {
    await this.clearGuidance();
    await this.requireAuthority();
    const current = this.runtime.get(this.taskId);
    if (["active", "waiting"].includes(current.status)) {
      this.runtime.control(current.id, current.revision, "pause");
      await this.runtime.settle?.(current.id);
    }
    return {
      kind: "paused",
      taskId: this.taskId,
      message: this.words.effectViolation,
    };
  }
  /** Checked browser evidence of forms sent while the website was hers, or null. */
  async manualActivity(snapshot) {
    const activity = snapshot.manualActivity;
    if (!activity) return null;
    if (!validManualActivity(activity)) {
      await this.clearGuidance();
      throw new BillHostError("Invalid manual activity evidence");
    }
    return activity;
  }
  /** Common task checks before a step; a result here ends the step. */
  async taskGate() {
    const task = this.runtime.get(this.taskId);
    if (task.status === "paused") {
      await this.clearGuidance();
      return { result: { kind: "paused", taskId: this.taskId } };
    }
    if (task.operations.some((operation) => operation.status === "unknown")) {
      await this.clearGuidance();
      return {
        result: {
          kind: "unknown-outcome",
          message: "Check the previous action before continuing.",
        },
      };
    }
    if (task.status !== "active") {
      await this.clearGuidance();
      return {
        result: {
          kind: "unavailable",
          message: "This task cannot currently observe the website.",
        },
      };
    }
    return { task };
  }
  /**
   * Runs reviewed host policy over the current observation. An asynchronous
   * result counts only if the task and every page fact are unchanged on a
   * fresh read; a guidance target is then moved to the fresh reference.
   */
  async decideOnFreshPage(
    { observation, snapshot },
    derive,
    { taskChanged, pageChanged },
  ) {
    const { epoch, revision } = this.runtime.get(this.taskId);
    const snapshotKey = policySnapshotKey(snapshot);
    let decision = derive(snapshot, {
      signal: this.signal,
      taskId: this.taskId,
      epoch,
    });
    if (!decision || typeof decision.then !== "function")
      return { decision, observation, snapshot };
    decision = await awaitPolicy(decision, this.signal);
    await this.requireAuthority();
    const current = this.runtime.get(this.taskId);
    if (
      current.status !== "active" ||
      current.epoch !== epoch ||
      current.revision !== revision
    ) {
      await this.clearGuidance();
      return { result: blocked(taskChanged) };
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
    await this.requireAuthority();
    const observed = this.runtime.get(this.taskId);
    if (observed.status !== "active" || observed.epoch !== epoch) {
      await this.clearGuidance();
      return { result: blocked(taskChanged) };
    }
    if (fresh.snapshot.effectViolation !== undefined)
      return { result: await this.pauseForEffectViolation() };
    if (snapshotKey !== policySnapshotKey(fresh.snapshot)) {
      await this.clearGuidance();
      return { result: blocked(pageChanged) };
    }
    if (decision?.guidanceTarget !== undefined) {
      const index = snapshot.elements.findIndex(
        (element) => element.selector === decision.guidanceTarget,
      );
      decision = {
        ...decision,
        guidanceTarget:
          index < 0 ? null : fresh.snapshot.elements[index].selector,
      };
    }
    return { decision, ...fresh };
  }
  /**
   * Shows one pointer at one observed control. Without the control, or when
   * the browser cannot show it, the instruction stays in the app panel.
   */
  async pointAt(
    decision,
    target,
    { stepId, instruction, restore, unavailable },
  ) {
    const guidance = { instruction, available: false };
    if (!target || !this.actuator.showGuidance) {
      await this.clearGuidance();
      return unavailable(guidance);
    }
    await this.requireAuthority();
    try {
      const shown = await this.actuator.showGuidance(
        this.taskId,
        this.runtime.owner,
        { stepId, targetRef: target.selector, text: instruction, restore },
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
      return unavailable(guidance);
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
  async refreshObserved({ restoreGuidance = false } = {}) {
    const gate = await this.taskGate();
    if (gate.result) return gate.result;
    const { task } = gate;
    await this.runtime.observe(
      task.id,
      task.revision,
      false,
      this.stillAuthorized,
    );
    const read = this.actuator.readObservation(task.id, this.runtime.owner);
    if (read.snapshot.effectViolation !== undefined)
      return this.pauseForEffectViolation();
    // A form she sent on this website while the task was paused or
    // restarted may have changed something. She checks it first.
    const activity = await this.manualActivity(read.snapshot);
    const origin = new URL(read.snapshot.url).origin;
    if (
      activity &&
      (activity.overflow ||
        activity.captureGap ||
        activity.events.some(
          (event) =>
            event.credential !== true &&
            event.origin === origin &&
            event.epoch < task.epoch,
        ))
    ) {
      const key = `manual-activity:${digest(activity)}`;
      if (!this.acknowledged.has(key)) {
        await this.clearGuidance();
        return {
          kind: "person-check",
          key,
          reason: "manual-activity",
          message: this.words.manualActivity,
        };
      }
    }
    const index = pageControls(read.snapshot);
    // A protected field is hers alone. When it is the next empty field of
    // its form, point at it without asking a model.
    const secret = index.protectedFields.find(
      ({ element }) => element.disabled !== true && element.hasInput !== true,
    );
    if (
      secret &&
      !index.controls.some(
        (control) =>
          control.kind === "field" &&
          control.index < secret.index &&
          (control.element.form?.index ?? null) ===
            (secret.element.form?.index ?? null) &&
          control.element.disabled !== true &&
          control.element.hasInput !== true,
      )
    ) {
      this.offer = null;
      const step = {
        kind: PROTECTED_KIND[secret.category] ?? "human-review",
        category: secret.category,
        message: this.words[secret.category],
      };
      return this.pointAt(step, secret.element, {
        stepId: `website:protected-${secret.category}`,
        instruction: step.message,
        restore: restoreGuidance,
        unavailable: (guidance) => ({ ...step, guidance }),
      });
    }
    // The step shown on the previous page joins history before the planner
    // reads this page. History lists steps shown on earlier pages, not steps
    // confirmed as done: a page change can come from navigation or an error,
    // so the planner judges progress from the page it reads now.
    const fingerprint = policySnapshotKey(read.snapshot);
    if (this.lastStep && this.lastStep.fingerprint !== fingerprint) {
      this.history.push(this.lastStep.step);
      this.lastStep = null;
    }
    const decided = await this.decideOnFreshPage(
      read,
      (snapshot, context) => {
        const page = pageView(snapshot, pageControls(snapshot));
        return Promise.resolve(
          this.planStep({ page, history: [...this.history] }, context),
        ).then((plan) => ({ plan }));
      },
      { taskChanged: this.words.changed, pageChanged: this.words.changed },
    );
    if (decided.result) return decided.result;
    const { snapshot } = decided;
    const plan = decided.decision.plan;
    if (
      !plan ||
      typeof plan !== "object" ||
      !STATUSES.includes(plan.status) ||
      typeof plan.message !== "string"
    )
      throw new BillHostError("Invalid website step");
    const { controls } = pageControls(snapshot);
    if (typeof plan.step === "string")
      this.lastStep = { fingerprint, step: plan.step };
    this.offer = null;
    if (plan.status !== "act") {
      await this.clearGuidance();
      return {
        kind: {
          wait: "wait",
          done: "done",
          blocked: "blocked",
          "needs-help": "needs-help",
        }[plan.status],
        step: plan.step,
        message: plan.message,
        ...(plan.status === "blocked" ? { reason: plan.message } : {}),
      };
    }
    const matches = controls.filter((control) => control.ref === plan.ref);
    const control = matches.length === 1 ? matches[0] : null;
    if (!control || control.element.disabled === true) {
      await this.clearGuidance();
      return blocked(this.words.noTarget);
    }
    const view = pageView(snapshot, {
      controls: [control],
      protectedFields: [],
    }).controls[0];
    const check = await this.checkStep?.({ plan, control: view });
    if (check && !this.acknowledged.has(check.key)) {
      await this.clearGuidance();
      return {
        kind: "person-check",
        key: check.key,
        reason: check.reason ?? "step",
        message: check.message,
      };
    }
    const instruction =
      typeof plan.instruction === "string" && plan.instruction.trim()
        ? plan.instruction
        : plan.message;
    const offer =
      plan.kind === "offer-fill" &&
      typeof plan.valueRef === "string" &&
      offerableField(control, controls);
    const decision = offer
      ? {
          kind: "offer-fill",
          ref: control.ref,
          step: plan.step,
          message: plan.message,
          offerKey: digest([
            this.taskId,
            control.ref,
            control.element.targetSelector,
            plan.valueRef,
            fingerprint,
          ]),
        }
      : {
          kind: "human-review",
          ref: control.ref,
          step: plan.step,
          message: plan.message,
        };
    if (offer)
      this.offer = {
        key: decision.offerKey,
        ref: control.ref,
        selector: control.element.targetSelector,
        valueRef: plan.valueRef,
        fingerprint,
      };
    return this.pointAt(decision, control.element, {
      stepId: `website:${decision.kind}`,
      instruction,
      restore: restoreGuidance,
      unavailable: (guidance) => ({ ...decision, guidance }),
    });
  }
  /**
   * Fills the offered value after the person said yes. It is one effect, on
   * the field she was shown, on the same unchanged page: every page fact is
   * read again and compared with the page of the offer first. A new fill
   * target is a new browser scope, so the task starts a new epoch for it (the
   * browser refuses a changed target in the same epoch). The page is read
   * again after the fill, and nothing else is pressed. A changed page gets a
   * new step instead.
   */
  async fill(offerKey, { operationId = randomUUID() } = {}) {
    const offer = this.offer;
    if (offer?.key !== offerKey) return this.refresh();
    const gate = await this.taskGate();
    if (gate.result) return gate.result;
    let { task } = gate;
    await this.clearGuidance();
    await this.requireAuthority();
    if (
      this.grant?.epoch !== task.epoch ||
      this.grant.selector !== offer.selector
    ) {
      this.runtime.control(task.id, task.revision, "pause");
      await this.runtime.settle?.(task.id);
      task = this.runtime.get(this.taskId);
      this.grant = { epoch: task.epoch, selector: offer.selector };
      task = await this.runtime.observe(
        task.id,
        task.revision,
        true,
        this.stillAuthorized,
      );
    } else
      task = await this.runtime.observe(
        task.id,
        task.revision,
        false,
        this.stillAuthorized,
      );
    const { observation, snapshot } = this.actuator.readObservation(
      task.id,
      this.runtime.owner,
    );
    if (snapshot.effectViolation !== undefined)
      return this.pauseForEffectViolation();
    const target = pageControls(snapshot).controls.find(
      (control) =>
        control.ref === offer.ref &&
        control.element.targetSelector === offer.selector,
    );
    if (policySnapshotKey(snapshot) !== offer.fingerprint || !target) {
      this.offer = null;
      return this.refresh();
    }
    await this.requireAuthority();
    this.offer = null;
    const id = `${GUIDED_FILL}${operationId}`;
    const result = await this.runtime.execute(task.id, task.revision, {
      id,
      taskId: task.id,
      epoch: task.epoch,
      observationId: observation.id,
      observationVersion: observation.version,
      inputRevision: observation.inputRevision,
      targetRef: target.element.selector,
      expectedSelector: offer.selector,
      capability: "browser.fill",
      valueRef: offer.valueRef,
      authorizationId: task.authorization.decisionId,
      expiresAt: Date.now() + 10000,
    });
    const operation = result.operations.find((item) => item.proposal.id === id);
    if (operation?.status === "succeeded") return this.refresh();
    if (operation?.status === "failed")
      return blocked(
        operation.evidenceRef === "not-dispatched"
          ? this.words.notSent
          : this.words.notFilled,
      );
    return { kind: "unknown-outcome", message: this.words.fillUnknown };
  }
}

/** Trusted native task annotations; never admitted as a model browser command. */

import { pageCommand } from "./commands.mjs";
import { guideFonts } from "./guide-font.mjs";
import { pageGuidance } from "./page-guidance.mjs";
import { BridgeError } from "./protocol.mjs";

const optionalText = (value, max) =>
  value === undefined ||
  (typeof value === "string" && value.trim() !== "" && value.length <= max);
const actionSentence = (value) =>
  typeof value === "string" &&
  value.trim() &&
  value.length <= 200 &&
  /^[^\p{Cc}\p{Cf}]+$/u.test(value)
    ? value
    : undefined;
/** Label words and offer answers are trusted host data, never model or page text. */
function validLabel(g) {
  if (
    !optionalText(g.detail, 300) ||
    (g.tone !== undefined &&
      !["instruction", "active", "offer", "success"].includes(g.tone))
  )
    return false;
  if (g.answers === undefined) return g.tone !== "offer";
  const answers = g.answers;
  if (
    g.tone !== "offer" ||
    !Array.isArray(answers) ||
    answers.length < 1 ||
    answers.length > 5 ||
    new Set(answers.map((answer) => answer?.id)).size !== answers.length ||
    answers.some(
      (answer) =>
        !answer ||
        typeof answer !== "object" ||
        Object.keys(answer).some(
          (key) => !["id", "kind", "text", "tag"].includes(key),
        ) ||
        typeof answer.id !== "string" ||
        !/^[A-Za-z0-9._:-]{1,64}$/.test(answer.id) ||
        !["card", "primary", "secondary"].includes(answer.kind) ||
        typeof answer.text !== "string" ||
        !optionalText(answer.text, 200) ||
        !optionalText(answer.tag, 60) ||
        (answer.tag !== undefined && answer.kind !== "card"),
    )
  )
    return false;
  // Value cards come in twos or threes; Yes (primary) is only for one value.
  const count = (kind) =>
    answers.filter((answer) => answer.kind === kind).length;
  return (
    [0, 2, 3].includes(count("card")) &&
    count("primary") + count("secondary") <= 2 &&
    count("primary") <= 1 &&
    !(count("primary") && count("card"))
  );
}
export function createTaskGuidance(api, authorize) {
  const active = new Map(),
    revisions = new Map(),
    queues = new Map();
  const stale = () =>
    new BridgeError(
      "STALE_REF",
      "Guidance context changed; observe the page again.",
    );
  const enqueue = (tabId, fn) => {
    const next = (queues.get(tabId) || Promise.resolve())
      .catch(() => {})
      .then(fn);
    queues.set(tabId, next);
    return next;
  };
  const indexKey = "task-guidance-tabs-v1";
  let metadata = Promise.resolve();
  const readIndex = async () => {
    const stored = (await api.storage.local.get(indexKey))[indexKey] ?? [];
    if (
      !Array.isArray(stored) ||
      stored.some((id) => typeof id !== "string" || !/^\d+$/.test(id))
    )
      throw new BridgeError(
        "UNAVAILABLE",
        "Guidance recovery index is invalid.",
      );
    return stored;
  };
  const track = (tabId, present) => {
    metadata = metadata
      .catch(() => {})
      .then(async () => {
        const ids = new Set(await readIndex());
        if (present) ids.add(tabId);
        else ids.delete(tabId);
        await api.storage.local.set({ [indexKey]: [...ids] });
      });
    return metadata;
  };
  const tabAbsent = async (tabId) =>
    !(await api.tabs.query({})).some((tab) => String(tab.id) === tabId);
  const hide = async (tabId) => {
    if (await tabAbsent(tabId)) return { visible: false, tabClosed: true };
    let results;
    try {
      results = await api.scripting.executeScript({
        target: { tabId: Number(tabId), frameIds: [0] },
        func: pageGuidance,
        args: [{ kind: "hide" }],
        world: "ISOLATED",
      });
    } catch (error) {
      // A tab can close between inventory and injection. A generic injection
      // error is not proof of removal; confirm absence independently.
      if (await tabAbsent(tabId)) return { visible: false, tabClosed: true };
      throw error;
    }
    if (
      results?.length !== 1 ||
      results[0].error ||
      results[0].result?.visible !== false
    )
      throw new BridgeError(
        "UNCERTAIN_OUTCOME",
        "Guidance removal was not acknowledged.",
      );
    return results[0].result;
  };
  function clearTab(tabId) {
    if (!active.has(tabId)) return Promise.resolve();
    const clearing = { id: null };
    active.set(tabId, clearing);
    return enqueue(tabId, async () => {
      await hide(tabId);
      await track(tabId, false);
      if (active.get(tabId) === clearing) active.delete(tabId);
    });
  }
  return {
    clearTab,
    async prepareAction(command, id, current) {
      const tabId = command.id,
        policy = command.taskPolicy;
      const match = /^([0-9a-f-]{36}):0:(\d+)$/.exec(command.selector || "");
      if (
        !policy ||
        !match ||
        !["click", "fill", "scroll"].includes(command.subaction)
      )
        throw stale();
      const ticket = { id };
      active.set(tabId, ticket);
      const valid = () => current() && active.get(tabId) === ticket;
      const actionId = `action:${id}`,
        expiresAt = Math.min(Date.now() + 5000, policy.expiresAt);
      const inject = async (func, args) => {
        if (!valid()) throw stale();
        const results = await api.scripting.executeScript({
          target: { tabId: Number(tabId), frameIds: [0] },
          func,
          args,
          world: "ISOLATED",
        });
        if (!valid()) throw stale();
        if (results?.length !== 1 || results[0].error || !results[0].result)
          throw stale();
        return results[0].result;
      };
      try {
        await enqueue(tabId, async () => {
          const result = await inject(pageCommand, [
            { ...command, snapshotId: match[1], nodeId: match[2] },
            null,
            true,
          ]);
          if (result.error)
            throw new BridgeError(result.error.kind, result.error.message);
          if (result.validated !== true) throw stale();
          await track(tabId, true);
          const shown = await inject(pageGuidance, [
            {
              kind: "show",
              id: actionId,
              snapshotId: match[1],
              nodeId: match[2],
              origin: policy.origin,
              expiresAt,
              action: command.subaction,
              assistantName: policy.assistantName,
              fonts: guideFonts,
              // The trusted host may word the preview for this step.
              text:
                actionSentence(command.actionText) ??
                {
                  click: "I will select this control.",
                  fill: "I will enter the approved information here.",
                  scroll: "I will scroll this area.",
                }[command.subaction],
            },
          ]);
          if (shown.accepted !== true) throw stale();
        });
        while (Date.now() < expiresAt) {
          const status = await enqueue(tabId, () =>
            inject(pageGuidance, [
              {
                kind: "action-status",
                id: actionId,
                snapshotId: match[1],
                nodeId: match[2],
                action: command.subaction,
              },
            ]),
          );
          if (status.ready === true) return { actionId, current: valid };
          if (status.cancelled) throw stale();
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw stale();
      } catch (error) {
        if (active.get(tabId) === ticket) await clearTab(tabId);
        throw error;
      }
    },
    async recover() {
      await metadata.catch(() => {});
      const ids = await readIndex();
      if (!ids.length) return;
      const live = new Set(
        (await api.tabs.query({})).map((tab) => String(tab.id)),
      );
      for (const tabId of ids) {
        if (!live.has(tabId)) {
          await track(tabId, false);
          continue;
        }
        if (!active.has(tabId)) active.set(tabId, { id: null });
        await clearTab(tabId);
      }
    },
    clearAll() {
      return Promise.all([...active.keys()].map(clearTab));
    },
    cancel(id) {
      const entry = [...active].find(([, value]) => value.id === id);
      return entry ? clearTab(entry[0]) : Promise.resolve();
    },
    /** One tap on a shown offer becomes a value-free answer event for the host. */
    answer(message, sender) {
      const tabId = String(sender?.tab?.id);
      const ticket = active.get(tabId),
        offer = ticket?.offer;
      if (
        !offer ||
        offer.answered ||
        !message ||
        Object.keys(message).sort().join(",") !==
          "answerId,answerKey,guideId,type" ||
        message.guideId !== offer.guideId ||
        message.answerKey !== offer.answerKey ||
        !offer.answerIds.includes(message.answerId) ||
        sender.id !== api.runtime.id ||
        sender.frameId !== 0 ||
        typeof offer.documentId !== "string" ||
        sender.documentId !== offer.documentId ||
        new URL(sender.url).origin !== offer.origin ||
        offer.expiresAt <= Date.now() ||
        !offer.current()
      )
        throw stale();
      offer.answered = true;
      return {
        type: "task-guide-answer",
        id: ticket.id,
        tabId,
        stepId: offer.stepId,
        revision: offer.revision,
        answerId: message.answerId,
      };
    },
    async handle(message, current) {
      const g = message.guidance;
      const allowed = [
        "tabId",
        "taskContext",
        "revision",
        "kind",
        "stepId",
        "selector",
        "text",
        "expiresAt",
        "restore",
        "detail",
        "tone",
        "answers",
      ];
      if (
        !message ||
        Object.keys(message).some(
          (key) => !["type", "id", "guidance"].includes(key),
        ) ||
        typeof message.id !== "string" ||
        !/^[A-Za-z0-9._:-]{1,128}$/.test(message.id) ||
        !g ||
        typeof g !== "object" ||
        Object.keys(g).some((key) => !allowed.includes(key)) ||
        typeof g.tabId !== "string" ||
        !/^\d+$/.test(g.tabId) ||
        !Number.isSafeInteger(Number(g.tabId)) ||
        !Number.isSafeInteger(g.revision) ||
        g.revision < 1 ||
        !["show", "hide", "pause"].includes(g.kind) ||
        (g.kind !== "show" &&
          Object.keys(g).some(
            (key) =>
              !["tabId", "taskContext", "revision", "kind"].includes(key),
          )) ||
        (g.kind === "show" &&
          (!validLabel(g) ||
            typeof g.stepId !== "string" ||
            !/^[A-Za-z0-9._:-]{1,128}$/.test(g.stepId) ||
            typeof g.selector !== "string" ||
            !/^[0-9a-f-]{36}:0:\d+$/.test(g.selector) ||
            typeof g.text !== "string" ||
            !g.text.trim() ||
            g.text.length > 600 ||
            !Number.isSafeInteger(g.expiresAt) ||
            g.expiresAt <= Date.now() ||
            g.expiresAt > Date.now() + 300000 ||
            (g.restore !== undefined && typeof g.restore !== "boolean")))
      )
        throw new BridgeError(
          "INVALID_REQUEST",
          "Invalid task guidance request.",
        );
      // Pause, like removal, only reduces what is drawn: owner-bound, and
      // available after lease expiry or navigation.
      const scope = await authorize(
        {
          id: g.tabId,
          subaction: "snapshot",
          taskContext: g.taskContext,
        },
        g.kind !== "show",
      );
      const valid = () => current() && scope.current();
      if (!valid() || !scope.command.taskPolicy) throw stale();
      const policy = scope.command.taskPolicy;
      const previous = revisions.get(g.tabId);
      if (
        previous?.scope === policy.guidanceScope &&
        g.revision <= previous.revision
      )
        throw stale();
      // Reserve ordering before storage yields. Failed persistence cannot restore an older guide.
      revisions.set(g.tabId, {
        scope: policy.guidanceScope,
        revision: g.revision,
      });
      const ticket = { id: message.id };
      active.set(g.tabId, ticket);
      const isCurrent = () => valid() && active.get(g.tabId) === ticket;
      try {
        const key = `request:${message.id}`;
        if ((await api.storage.local.get(key))[key]) throw stale();
        await api.storage.local.set({ [key]: "admitted" });
        return await enqueue(g.tabId, async () => {
          if (!isCurrent()) throw stale();
          await track(g.tabId, true);
          if (!isCurrent()) throw stale();
          const match = g.selector?.split(":");
          const answerKey = g.answers ? crypto.randomUUID() : undefined;
          const request =
            g.kind === "show"
              ? {
                  kind: "show",
                  id: `${policy.guidanceScope}:${g.stepId}`,
                  snapshotId: match[0],
                  nodeId: match[2],
                  origin: policy.origin,
                  expiresAt: Math.min(g.expiresAt, policy.expiresAt),
                  text: g.text,
                  restore: g.restore,
                  detail: g.detail,
                  tone: g.tone,
                  answers: g.answers,
                  answerKey,
                  assistantName: policy.assistantName,
                  fonts: guideFonts,
                }
              : { kind: g.kind };
          const [result] =
            g.kind === "hide"
              ? [{ result: await hide(g.tabId) }]
              : await api.scripting.executeScript({
                  target: { tabId: Number(g.tabId), frameIds: [0] },
                  func: pageGuidance,
                  args: [request],
                  world: "ISOLATED",
                });
          if (!isCurrent()) {
            await hide(g.tabId);
            throw stale();
          }
          if (result?.error || !result?.result || result.result.reason)
            throw new BridgeError(
              "STALE_REF",
              "Guidance needs a fresh page observation.",
            );
          if (
            (g.kind !== "show" && result.result.visible !== false) ||
            (g.kind === "show" && result.result.accepted !== true)
          )
            throw new BridgeError(
              "UNCERTAIN_OUTCOME",
              "Guidance change was not acknowledged.",
            );
          if (g.kind === "hide") {
            await track(g.tabId, false);
            if (active.get(g.tabId) === ticket) active.delete(g.tabId);
          }
          // Answers are accepted only for this exact show: same ticket, binding,
          // transport generation, document and per-show key.
          if (answerKey)
            ticket.offer = {
              guideId: request.id,
              answerKey,
              answerIds: g.answers.map((answer) => answer.id),
              documentId: result.documentId,
              origin: policy.origin,
              stepId: g.stepId,
              revision: g.revision,
              expiresAt: request.expiresAt,
              current: isCurrent,
            };
          return result.result;
        });
      } catch (error) {
        if (active.get(g.tabId) === ticket) await clearTab(g.tabId);
        throw error;
      }
    },
  };
}

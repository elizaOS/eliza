import { BILL_SOURCE_FAILURE_REASONS } from "./bill-source-discovery.mjs";
import { BillHostError } from "./errors.mjs";

/**
 * Fixed reasons on a failed bill route's 503. They never carry page text,
 * values or error messages.
 */
export const BILL_WORKFLOW_FAILURE_REASONS = Object.freeze([
  "profile-unavailable",
  "workflow-missing",
  "store-error",
  "unknown",
]);

// Error names are writable and can contain upstream page data. Only emit known
// diagnostic categories, never an arbitrary name supplied by a workflow.
const diagnosticErrorNames = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "URIError",
  "EvalError",
  "AggregateError",
  "AbortError",
  "TimeoutError",
  "BillHostError",
]);

/** Optional bill-task HTTP facade over the host's existing task runtime and stores. */
export function createBillTaskRoutes({
  workflowFactory,
  onDiagnostic,
  discoverBills,
  requiresBillSelection = false,
  copy,
  db,
  choiceStore,
  outcomeStore,
  sourceStore,
  InteractiveTaskChoices,
  SqliteTaskPresentation,
}) {
  for (const key of [
    "existingMethodPrompt",
    "existingMethodLabel",
    "pendingChoiceMessage",
    "staleChoiceMessage",
  ]) {
    if (typeof copy?.[key] !== "string" || !copy[key].trim())
      throw new BillHostError(`Missing host bill presentation: ${key}`);
  }
  return async (
    request,
    { owner, runtime, authenticate, requestEpoch, currentEpoch },
  ) => {
    if (
      request.method === "GET" &&
      new URL(request.url).pathname === "/tasks/latest-outcome"
    )
      return Response.json(
        { outcome: outcomeStore.latest(owner) },
        { headers: { "Cache-Control": "no-store" } },
      );
    const sourceRoute =
      /^\/tasks\/([A-Za-z0-9][A-Za-z0-9_.:@-]{0,255})\/source-bills$/.exec(
        new URL(request.url).pathname,
      );
    if (sourceRoute) {
      if (!["GET", "POST"].includes(request.method))
        return Response.json(
          { code: "TASK_METHOD_NOT_ALLOWED" },
          { status: 405 },
        );
      if (new URL(request.url).search)
        return Response.json({ code: "TASK_INVALID" }, { status: 400 });
      if (!discoverBills)
        return Response.json(
          { code: "BILL_DISCOVERY_UNAVAILABLE" },
          { status: 404 },
        );
      try {
        const task = runtime.get(sourceRoute[1]);
        if (
          task.authorization.state !== "active" ||
          !["active", "waiting"].includes(task.status)
        )
          throw new BillHostError("Inactive bill discovery");
        const sources = sourceStore.forTask(runtime, task.id);
        let input;
        if (request.method === "POST") {
          const text = await request.text();
          if (text.length > 1024)
            return Response.json({ code: "TASK_INVALID" }, { status: 400 });
          try {
            input = JSON.parse(text);
          } catch {
            return Response.json({ code: "TASK_INVALID" }, { status: 400 });
          }
          if (
            !input ||
            Object.keys(input).sort().join(",") !==
              "candidateId,expectedRevision,offerId" ||
            !/^[a-f0-9-]{36}$/.test(input.offerId) ||
            !/^[a-f0-9]{64}$/.test(input.candidateId) ||
            !Number.isSafeInteger(input.expectedRevision) ||
            input.expectedRevision < 0
          )
            return Response.json({ code: "TASK_INVALID" }, { status: 400 });
        }
        const selected = sources.load();
        if (selected) {
          const current = await authenticate(),
            latest = runtime.get(task.id);
          if (
            request.signal.aborted ||
            requestEpoch !== currentEpoch() ||
            current.actorId !== owner.actorId ||
            latest.epoch !== task.epoch ||
            latest.authorization.state !== "active"
          )
            return Response.json(
              { code: "TASK_UNAUTHORIZED" },
              { status: 401 },
            );
          if (
            input &&
            (input.offerId !== selected.offerId ||
              input.candidateId !== selected.candidate.candidateId)
          )
            return Response.json(
              { code: "BILL_SELECTION_STALE" },
              { status: 409 },
            );
          return Response.json(
            { status: "selected", selection: selected },
            { headers: { "Cache-Control": "no-store" } },
          );
        }
        const result = await discoverBills({
          runtime,
          task,
          signal: request.signal,
        });
        const current = await authenticate(),
          latest = runtime.get(task.id);
        if (
          request.signal.aborted ||
          requestEpoch !== currentEpoch() ||
          current.actorId !== owner.actorId ||
          latest.epoch !== task.epoch ||
          latest.authorization.state !== "active" ||
          !["active", "waiting"].includes(latest.status)
        )
          return Response.json({ code: "TASK_UNAUTHORIZED" }, { status: 401 });
        const response = input
          ? { status: "selected", selection: sources.select(input, result) }
          : sources.offer(result, task.revision);
        return Response.json(response, {
          headers: { "Cache-Control": "no-store" },
        });
      } catch (error) {
        if (error?.code === "BILL_SELECTION_STALE")
          return Response.json(
            { code: "BILL_SELECTION_STALE" },
            { status: 409 },
          );
        // A fixed reason (for example reauth_required) tells the person what
        // to do next. Provider text never leaves the host.
        return Response.json(
          {
            code: "BILL_DISCOVERY_UNAVAILABLE",
            reason: BILL_SOURCE_FAILURE_REASONS.includes(error?.reason)
              ? error.reason
              : "unavailable",
          },
          { status: 503 },
        );
      }
    }
    const billRoute =
      /^\/tasks\/([A-Za-z0-9][A-Za-z0-9_.:@-]{0,255})\/bill$/.exec(
        new URL(request.url).pathname,
      );
    if (billRoute) {
      // The failure reason of the innermost step running when an error is
      // thrown: a step that throws leaves its own reason in place. A
      // synchronous step stays synchronous.
      let stage = "unknown";
      const step = (reason, operation) => {
        const outer = stage;
        stage = reason;
        const result = operation();
        if (typeof result?.then !== "function") {
          stage = outer;
          return result;
        }
        return result.then((value) => {
          stage = outer;
          return value;
        });
      };
      const stored = (operation) => step("store-error", operation);
      try {
        if (new URL(request.url).search)
          return Response.json({ code: "TASK_INVALID" }, { status: 400 });
        const task = stored(() => runtime.get(billRoute[1]));
        const outcomes = stored(() => outcomeStore.forTask(runtime, task.id));
        if (request.method === "GET" && stored(() => outcomes.load()))
          return Response.json(
            {
              decision: stored(() => ({
                ...outcomes.retry(),
                billSources: sourceStore.forTask(runtime, task.id).load()
                  ?.candidate.sources,
              })),
            },
            { headers: { "Cache-Control": "no-store" } },
          );
        const sourceSelection = stored(() =>
          sourceStore.forTask(runtime, task.id).load(),
        );
        if (requiresBillSelection && !sourceSelection)
          return Response.json(
            { decision: { kind: "source-selection-required" } },
            { headers: { "Cache-Control": "no-store" } },
          );
        if (!workflowFactory)
          return Response.json(
            { code: "BILL_WORKFLOW_UNAVAILABLE" },
            { status: 404 },
          );
        const workflow = step("workflow-missing", () => {
          const workflow = workflowFactory({
            runtime,
            task,
            outcomes,
            sourceSelection,
            signal: request.signal,
            stillAuthorized: async () => {
              try {
                const current = await authenticate();
                return (
                  !request.signal.aborted &&
                  requestEpoch === currentEpoch() &&
                  current.actorId === owner.actorId
                );
              } catch {
                return false;
              }
            },
          });
          if (typeof workflow?.refresh !== "function")
            throw new BillHostError("Bill workflow unavailable");
          return workflow;
        });
        const choices = new InteractiveTaskChoices(runtime, choiceStore);
        const presentation = new SqliteTaskPresentation(db, runtime, choices);
        const withChoice = async (decision) => {
          if (decision.kind === "choose-existing-method")
            return {
              ...decision,
              choice: await stored(() =>
                presentation.publish(task.id, decision.reviewKey, {
                  kind: "choice",
                  id: "existing-method",
                  scope: "bill-existing-method",
                  prompt: copy.existingMethodPrompt,
                  options: [
                    { value: "existing", label: copy.existingMethodLabel },
                  ],
                }),
              ),
            };
          stored(() => presentation.clear(task.id));
          return decision;
        };
        let decision;
        if (request.method === "GET") decision = await workflow.refresh();
        else if (request.method === "POST") {
          const text = await request.text();
          if (text.length > 2048)
            return Response.json({ code: "TASK_INVALID" }, { status: 400 });
          let input;
          try {
            input = JSON.parse(text);
          } catch {
            // Malformed client input, not an unavailable workflow (the source
            // route answers the same way).
            return Response.json({ code: "TASK_INVALID" }, { status: 400 });
          }
          if (
            input &&
            Object.keys(input).length === 1 &&
            input.action === "show-guidance"
          ) {
            decision = await workflow.refresh({ restoreGuidance: true });
          } else {
            if (
              !input ||
              Object.keys(input).length !== 3 ||
              typeof input.callbackData !== "string" ||
              !/^is1:[a-f0-9]{32}$/.test(input.callbackData) ||
              typeof input.contextKey !== "string" ||
              !/^[a-f0-9]{64}$/.test(input.contextKey) ||
              input.value !== "existing"
            )
              return Response.json({ code: "TASK_INVALID" }, { status: 400 });
            if (stored(() => outcomes.load()))
              decision = stored(() => outcomes.retry());
            else {
              let handled;
              try {
                // Deduplicate before observing again: a repeated delivery must not
                // invalidate the first delivery's in-flight observation/proposal.
                // The echoed context is bound to the persisted offered choice;
                // the workflow re-observes and compares it before any effect.
                const result = await stored(() =>
                  choices.respond({
                    taskId: task.id,
                    contextKey: input.contextKey,
                    callbackData: input.callbackData,
                    value: input.value,
                    execute: async ({ operationId, isCurrent }) => {
                      handled = await step("unknown", () =>
                        workflow.chooseExistingMethod(input.contextKey, {
                          operationId,
                          isCurrent,
                        }),
                      );
                      return { decision: handled.kind };
                    },
                  }),
                );
                decision =
                  result.status === "in_progress"
                    ? {
                        kind: "choice-pending",
                        message: copy.pendingChoiceMessage,
                      }
                    : handled || (await workflow.refresh());
              } catch (error) {
                if (error?.code !== "TASK_CHOICE_STALE") throw error;
                // The stale choice is handled: the refresh is not a store step.
                stage = "unknown";
                decision = {
                  ...(await workflow.refresh()),
                  message: copy.staleChoiceMessage,
                };
              }
            }
          }
        } else
          return Response.json(
            { code: "TASK_METHOD_NOT_ALLOWED" },
            { status: 405 },
          );
        decision = await withChoice(decision);
        const current = await authenticate();
        if (
          request.signal.aborted ||
          requestEpoch !== currentEpoch() ||
          current.actorId !== owner.actorId
        )
          return Response.json({ code: "TASK_UNAUTHORIZED" }, { status: 401 });
        return Response.json(
          {
            decision: {
              ...decision,
              ...(sourceSelection
                ? { billSources: sourceSelection.candidate.sources }
                : {}),
            },
          },
          { headers: { "Cache-Control": "no-store" } },
        );
      } catch (error) {
        if (error?.code === "TASK_NOT_FOUND")
          return Response.json({ code: "TASK_NOT_FOUND" }, { status: 404 });
        const reason =
          error?.reason === "profile-unavailable" ? error.reason : stage;
        try {
          // Keep diagnostic metadata within the fixed vocabulary.
          const name = error?.name;
          onDiagnostic?.({
            route: "bill",
            taskId: billRoute[1],
            reasonCode: reason,
            name: diagnosticErrorNames.has(name) ? name : undefined,
          });
        } catch {}
        return Response.json(
          { code: "BILL_WORKFLOW_UNAVAILABLE", reason },
          { status: 503 },
        );
      }
    }
    return null;
  };
}

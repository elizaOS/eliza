/**
 * Observe serving model identities at the runtime event boundary, separating
 * actor calls from judge calls through asynchronous scope. Missing events or
 * identities remain unavailable; credentials do not establish independence.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import {
  ElizaError,
  EventType,
  type IAgentRuntime,
  type ModelEventPayload,
} from "@elizaos/core";

export interface ObservedJudgeModel {
  provider: string | null;
  model: string | null;
  source: "runtime-event" | "provider-response" | "unavailable";
}
export type JudgeIndependence = "independent" | "self-graded" | "unknown";
const active = new WeakMap<IAgentRuntime, JudgeModelObserver>();
const textTypes = new Set([
  "TEXT_SMALL",
  "TEXT_LARGE",
  "OBJECT_SMALL",
  "OBJECT_LARGE",
  "ACTION_PLANNER",
  "RESPONSE_HANDLER",
]);
const unavailable = (): ObservedJudgeModel => ({
  provider: null,
  model: null,
  source: "unavailable",
});
function present(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
export function compareJudgeModels(
  actors: readonly ObservedJudgeModel[],
  judges: readonly ObservedJudgeModel[],
): JudgeIndependence {
  if (
    !actors.length ||
    !judges.length ||
    [...actors, ...judges].some((row) => !row.provider || !row.model)
  )
    return "unknown";
  const modelKey = (row: ObservedJudgeModel) =>
    row.model?.trim().toLowerCase().split("/").at(-1);
  if (
    actors.some((actor) =>
      judges.some((judge) => modelKey(actor) === modelKey(judge)),
    )
  )
    return "self-graded";
  // Runtime events may contain request aliases or gateway labels rather than
  // the identity returned by the serving endpoint. They cannot certify a split.
  if ([...actors, ...judges].some((row) => row.source !== "provider-response"))
    return "unknown";
  return "independent";
}
export function getJudgeModelObserver(
  runtime: IAgentRuntime,
): JudgeModelObserver | undefined {
  return active.get(runtime);
}

export class JudgeModelObserver {
  private readonly actors: ObservedJudgeModel[] = [];
  private readonly judgeScope = new AsyncLocalStorage<ObservedJudgeModel[]>();
  private readonly callScope = new AsyncLocalStorage<ObservedJudgeModel[]>();
  private readonly original: IAgentRuntime["useModel"];
  private readonly wrapped: IAgentRuntime["useModel"];
  private readonly subscribed: boolean;
  private readonly onModel = async (event: ModelEventPayload) => {
    if (event.runtime !== this.runtime || !textTypes.has(String(event.type)))
      return;
    this.callScope.getStore()?.push({
      provider: present(event.provider),
      model: present(event.model ?? event.modelName),
      source: "runtime-event",
    });
  };
  constructor(private readonly runtime: IAgentRuntime) {
    if (active.has(runtime))
      throw new ElizaError(
        "A scenario already owns this runtime's model observer",
        { code: "SCENARIO_MODEL_OBSERVER_ALREADY_ACTIVE" },
      );
    this.original = runtime.useModel;
    const observer = this;
    this.wrapped = new Proxy(this.original, {
      apply(target, thisArg, args) {
        if (!textTypes.has(String(args[0])) || observer.callScope.getStore())
          return Reflect.apply(target, thisArg, args);
        const models: ObservedJudgeModel[] = [];
        return observer.callScope.run(models, async () => {
          try {
            return await Reflect.apply(target, thisArg, args);
          } finally {
            const destination =
              observer.judgeScope.getStore() ?? observer.actors;
            destination.push(...(models.length ? models : [unavailable()]));
          }
        });
      },
    });
    this.subscribed =
      typeof runtime.registerEvent === "function" &&
      typeof runtime.unregisterEvent === "function";
    if (this.subscribed)
      runtime.registerEvent(EventType.MODEL_USED, this.onModel);
    runtime.useModel = this.wrapped;
    active.set(runtime, this);
  }
  actorModels(): ObservedJudgeModel[] {
    return this.actors.map((row) => ({ ...row }));
  }
  async judge<T>(
    call: () => Promise<T>,
  ): Promise<{ value: T; models: ObservedJudgeModel[] }> {
    const models: ObservedJudgeModel[] = [];
    const value = await this.judgeScope.run(models, call);
    return { value, models: models.length ? models : [unavailable()] };
  }
  close(): void {
    if (this.runtime.useModel === this.wrapped)
      this.runtime.useModel = this.original;
    if (this.subscribed)
      this.runtime.unregisterEvent(EventType.MODEL_USED, this.onModel);
    active.delete(this.runtime);
  }
}

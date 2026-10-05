/** Owns deferred startup work so it cannot access storage after runtime shutdown. */
import { type IAgentRuntime, Service } from "@elizaos/core";

const instances = new WeakMap<IAgentRuntime, PersonalAssistantStartupService>();

export class PersonalAssistantStartupService extends Service {
  static serviceType = "personal_assistant_startup";
  capabilityDescription = "Personal assistant startup maintenance lifecycle";
  private pending = new Set<Promise<void>>();
  private releaseStop!: () => void;
  private readonly stopRequested = new Promise<void>((resolve) => {
    this.releaseStop = resolve;
  });
  stopping = false;

  static forRuntime(runtime: IAgentRuntime): PersonalAssistantStartupService {
    let service = instances.get(runtime);
    if (!service) {
      service = new PersonalAssistantStartupService(runtime);
      instances.set(runtime, service);
    }
    return service;
  }

  static async start(
    runtime: IAgentRuntime,
  ): Promise<PersonalAssistantStartupService> {
    return PersonalAssistantStartupService.forRuntime(runtime);
  }

  runAfterInit(
    work: () => unknown,
    onError: (error: unknown) => unknown,
  ): void {
    if (this.stopping) return;
    const task = Promise.race([this.runtime.initPromise, this.stopRequested])
      .then(async () => {
        if (!this.stopping) await work();
      })
      .catch(async (error) => {
        if (!this.stopping) await onError(error);
      })
      .catch((error) => {
        this.runtime.reportError("PersonalAssistant.startup", error);
      })
      .finally(() => {
        this.pending.delete(task);
      });
    this.pending.add(task);
  }

  async wait(delayMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.stopRequested,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, delayMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  override prepareStop(): void {
    this.stopping = true;
    this.releaseStop();
  }

  async stop(): Promise<void> {
    this.prepareStop();
    await Promise.allSettled([...this.pending]);
    instances.delete(this.runtime);
  }
}

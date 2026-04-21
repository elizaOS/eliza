import { CodingTaskExecutor } from "./coding-task-executor.js";
import { ResearchTaskExecutor } from "./research-task-executor.js";
import { TaskExecutorRegistry } from "./task-executor.js";

/** Create a registry pre-populated with all built-in executors */
export function createDefaultExecutorRegistry(): TaskExecutorRegistry {
  const registry = new TaskExecutorRegistry();
  registry.register(new CodingTaskExecutor());
  registry.register(new ResearchTaskExecutor());
  return registry;
}

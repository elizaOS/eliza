import type { BackgroundModule } from "./types";

interface RegistryEntry {
  module: BackgroundModule;
  registeredAt: number;
}

const MAX_HISTORY = 3;

const modules = new Map<string, BackgroundModule>();
const history: RegistryEntry[] = [];
let activeId: string | undefined;

export function registerBackground(module: BackgroundModule): void {
  modules.set(module.id, module);
  history.push({ module, registeredAt: Date.now() });
  while (history.length > MAX_HISTORY) {
    history.shift();
  }
  if (!activeId) {
    activeId = module.id;
  }
}

export function getActiveBackground(): BackgroundModule | undefined {
  if (!activeId) return undefined;
  return modules.get(activeId);
}

export function setActiveBackground(id: string): BackgroundModule | undefined {
  const next = modules.get(id);
  if (!next) return undefined;
  activeId = id;
  return next;
}

export function getBackground(id: string): BackgroundModule | undefined {
  return modules.get(id);
}

export function listBackgrounds(): readonly BackgroundModule[] {
  return Array.from(modules.values());
}

export function getBackgroundHistory(): readonly BackgroundModule[] {
  return history.map((entry) => entry.module);
}

export function revertBackground(): BackgroundModule | undefined {
  if (history.length < 2) return undefined;
  const previous = history[history.length - 2];
  if (!previous) return undefined;
  activeId = previous.module.id;
  return previous.module;
}

export function resetBackgroundRegistry(): void {
  modules.clear();
  history.length = 0;
  activeId = undefined;
}

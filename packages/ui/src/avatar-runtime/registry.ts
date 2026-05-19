import type { AvatarModule } from "./types";

const MAX_HISTORY = 3;

const modules = new Map<string, AvatarModule>();
const history: AvatarModule[] = [];
let activeId: string | undefined;

export function registerAvatar(module: AvatarModule): void {
  modules.set(module.id, module);
  history.push(module);
  while (history.length > MAX_HISTORY) {
    history.shift();
  }
  if (!activeId) {
    activeId = module.id;
  }
}

export function getActiveAvatar(): AvatarModule | undefined {
  if (!activeId) return undefined;
  return modules.get(activeId);
}

export function getAvatar(id: string): AvatarModule | undefined {
  return modules.get(id);
}

export function setActiveAvatar(id: string): AvatarModule | undefined {
  const next = modules.get(id);
  if (!next) return undefined;
  activeId = id;
  return next;
}

export function listAvatars(): readonly AvatarModule[] {
  return Array.from(modules.values());
}

export function getAvatarHistory(): readonly AvatarModule[] {
  return [...history];
}

export function revertAvatar(): AvatarModule | undefined {
  if (history.length < 2) return undefined;
  const previous = history[history.length - 2];
  if (!previous) return undefined;
  activeId = previous.id;
  return previous;
}

export function resetAvatarRegistry(): void {
  modules.clear();
  history.length = 0;
  activeId = undefined;
}

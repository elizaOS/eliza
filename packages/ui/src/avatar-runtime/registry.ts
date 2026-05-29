import type { AvatarModule } from "./types";

const modules = new Map<string, AvatarModule>();
let activeId: string | undefined;

export function registerAvatar(module: AvatarModule): void {
  modules.set(module.id, module);
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

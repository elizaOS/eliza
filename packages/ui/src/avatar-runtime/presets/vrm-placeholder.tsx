import type { AvatarContext, AvatarHandle, AvatarModule } from "../types";

export function createVrmPlaceholderAvatar(): AvatarModule {
  return {
    id: "vrm",
    title: "VRM 3D model",
    kind: "vrm",
    mount(target: HTMLElement, _ctx: AvatarContext): AvatarHandle {
      const wrap = document.createElement("div");
      wrap.style.width = "100%";
      wrap.style.height = "100%";
      wrap.style.display = "grid";
      wrap.style.placeItems = "center";
      wrap.style.color = "rgba(255,255,255,0.86)";
      wrap.style.fontSize = "14px";
      wrap.textContent = "VRM preset (load deferred)";
      target.appendChild(wrap);
      return {
        unmount(): void {
          wrap.remove();
        },
      };
    },
  };
}

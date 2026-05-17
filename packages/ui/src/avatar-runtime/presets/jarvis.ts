import type { AvatarContext, AvatarHandle, AvatarModule } from "../types";

const RING_COUNT = 5;

export function createJarvisAvatar(): AvatarModule {
  return {
    id: "jarvis",
    title: "Jarvis",
    kind: "canvas",
    mount(target: HTMLElement, ctx: AvatarContext): AvatarHandle {
      const canvas = document.createElement("canvas");
      canvas.width = 520;
      canvas.height = 320;
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      canvas.style.display = "block";
      target.appendChild(canvas);
      const renderingContext = canvas.getContext("2d");
      if (!renderingContext) {
        return { unmount: () => canvas.remove() };
      }
      let raf = 0;
      let phase = 0;

      const draw = (): void => {
        const width = canvas.width;
        const height = canvas.height;
        renderingContext.clearRect(0, 0, width, height);
        const cx = width / 2;
        const cy = height / 2;
        const level = Math.max(0, Math.min(1, ctx.audioLevel()));
        const baseRadius = 36;
        for (let r = 0; r < RING_COUNT; r += 1) {
          const t = r / (RING_COUNT - 1);
          const radius = baseRadius + r * 22 + level * 14;
          renderingContext.beginPath();
          renderingContext.arc(
            cx,
            cy,
            radius,
            phase * 0.3 + r * 0.4,
            Math.PI * 1.6 + phase * 0.3 + r * 0.4,
          );
          renderingContext.lineWidth = 1.5;
          renderingContext.strokeStyle =
            r === RING_COUNT - 1
              ? `rgba(255,138,36,${0.8 - t * 0.2})`
              : `rgba(255,255,255,${0.78 - t * 0.18})`;
          renderingContext.stroke();
        }
        phase += 0.02;
        raf = requestAnimationFrame(draw);
      };
      raf = requestAnimationFrame(draw);

      return {
        unmount(): void {
          cancelAnimationFrame(raf);
          canvas.remove();
        },
      };
    },
  };
}

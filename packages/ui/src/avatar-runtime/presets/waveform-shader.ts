import type { AvatarContext, AvatarHandle, AvatarModule } from "../types";

const POINT_COUNT = 96;

function createCanvas(target: HTMLElement): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = 520;
  canvas.height = 320;
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.display = "block";
  canvas.style.filter =
    "drop-shadow(0 0 12px rgba(255, 255, 255, 0.78)) drop-shadow(0 3px 12px rgba(5, 48, 88, 0.38))";
  target.appendChild(canvas);
  return canvas;
}

export function createWaveformAvatar(): AvatarModule {
  return {
    id: "waveform",
    title: "Waveform shader",
    kind: "canvas",
    mount(target: HTMLElement, ctx: AvatarContext): AvatarHandle {
      const canvas = createCanvas(target);
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
        const mid = height / 2;
        const level = Math.max(0, Math.min(1, ctx.audioLevel()));
        const speaking = ctx.speakingState();
        const intensity = speaking === "speaking" ? 1 : level;
        const baseAmp = 18 + intensity * 86;

        renderingContext.lineWidth = 3;
        renderingContext.strokeStyle = "rgba(255,255,255,0.92)";
        renderingContext.beginPath();
        for (let i = 0; i <= POINT_COUNT; i += 1) {
          const t = i / POINT_COUNT;
          const x = t * width;
          const wave =
            Math.sin(t * Math.PI * 4 + phase) * 0.6 +
            Math.sin(t * Math.PI * 8 + phase * 1.3) * 0.4;
          const y = mid + wave * baseAmp * (0.6 + 0.4 * Math.sin(t * Math.PI));
          if (i === 0) renderingContext.moveTo(x, y);
          else renderingContext.lineTo(x, y);
        }
        renderingContext.stroke();

        renderingContext.lineWidth = 1.5;
        renderingContext.strokeStyle = "rgba(255,200,140,0.6)";
        renderingContext.beginPath();
        for (let i = 0; i <= POINT_COUNT; i += 1) {
          const t = i / POINT_COUNT;
          const x = t * width;
          const wave = Math.sin(t * Math.PI * 6 + phase * 0.8);
          const y = mid + wave * baseAmp * 0.45;
          if (i === 0) renderingContext.moveTo(x, y);
          else renderingContext.lineTo(x, y);
        }
        renderingContext.stroke();

        phase += 0.04 + intensity * 0.08;
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

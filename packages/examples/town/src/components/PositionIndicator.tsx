import type { Graphics as PixiGraphics } from "pixi.js";

const ANIMATION_DURATION = 500;
const RADIUS_TILES = 0.25;

export function PositionIndicator(props: {
  destination: { x: number; y: number; t: number };
  tileDim: number;
}) {
  const { destination, tileDim } = props;
  const draw = (g: PixiGraphics) => {
    g.clear();
    const now = Date.now();
    if (destination.t + ANIMATION_DURATION <= now) {
      return;
    }
    const progress = (now - destination.t) / ANIMATION_DURATION;
    const x = destination.x * tileDim;
    const y = destination.y * tileDim;
    g.lineStyle(1.5, { h: 0, s: 50, l: 90 }, 0.5);
    g.drawCircle(x, y, RADIUS_TILES * progress * tileDim);
  };
  return <pixiGraphics draw={draw} />;
}

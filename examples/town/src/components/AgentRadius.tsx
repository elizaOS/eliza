import type { Graphics as PixiGraphics } from "pixi.js";
import { useCallback } from "react";
import type { TownAgent } from "../../shared/types";

const VISION_COLOR = 0x3b82f6;
const AUDIO_COLOR = 0xf59e0b;

export function AgentRadius({
  agent,
  tileDim,
}: {
  agent: TownAgent;
  tileDim: number;
}) {
  const renderPosition = agent.renderPosition ?? agent.position;
  const visionRadius = agent.visionRangeTiles * tileDim;
  const audioRadius = agent.audioRangeTiles * tileDim;
  const draw = useCallback(
    (g: PixiGraphics) => {
      g.clear();
      g.lineStyle(2, VISION_COLOR, 0.6);
      g.beginFill(VISION_COLOR, 0.08);
      g.drawCircle(0, 0, visionRadius);
      g.endFill();
      g.lineStyle(2, AUDIO_COLOR, 0.6);
      g.beginFill(AUDIO_COLOR, 0.05);
      g.drawCircle(0, 0, audioRadius);
      g.endFill();
    },
    [audioRadius, visionRadius],
  );
  return (
    <pixiGraphics
      x={renderPosition.x * tileDim}
      y={renderPosition.y * tileDim}
      draw={draw}
    />
  );
}

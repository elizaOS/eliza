import * as PIXI from "pixi.js";
import { Spritesheet, type SpritesheetData } from "pixi.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export const Character = ({
  textureUrl,
  spritesheetData,
  x,
  y,
  orientation,
  isMoving = false,
  thoughtText,
  speechText,
  headOffsetPx = 48,
  emoji = "",
  isViewer = false,
  speed = 0.1,
  onClick,
}: {
  // Path to the texture packed image.
  textureUrl: string;
  // The data for the spritesheet.
  spritesheetData: SpritesheetData;
  // The pose of the NPC.
  x: number;
  y: number;
  orientation: number;
  isMoving?: boolean;
  thoughtText?: string;
  speechText?: string;
  headOffsetPx?: number;
  emoji?: string;
  // Highlights the player.
  isViewer?: boolean;
  // The speed of the animation. Can be tuned depending on the side and speed of the NPC.
  speed?: number;
  onClick: () => void;
}) => {
  const [spriteSheet, setSpriteSheet] = useState<Spritesheet>();
  useEffect(() => {
    const parseSheet = async () => {
      const texture = (await PIXI.Assets.load(textureUrl)) as
        | PIXI.Texture
        | undefined;
      if (
        !texture ||
        typeof texture !== "object" ||
        !("source" in texture) ||
        !texture.source
      ) {
        return;
      }
      texture.source.scaleMode = "nearest";
      const sheet = new Spritesheet(texture, spritesheetData);
      await sheet.parse();
      setSpriteSheet(sheet);
    };
    void parseSheet();
  }, [textureUrl, spritesheetData]);

  // The first "left" is "right" but reflected.
  const roundedOrientation = Math.floor(orientation / 90);
  const direction = ["right", "down", "left", "up"][roundedOrientation];

  // Prevents the animation from stopping when the texture changes
  // (see https://github.com/pixijs/pixi-react/issues/359)
  const ref = useRef<PIXI.AnimatedSprite | null>(null);
  useEffect(() => {
    const sprite = ref.current;
    if (!sprite) {
      return;
    }
    if (isMoving) {
      sprite.play();
    } else {
      sprite.gotoAndStop(0);
    }
  }, [isMoving]);

  if (!spriteSheet) return null;

  const showThought = thoughtText && thoughtText.trim().length > 0;
  const showSpeech = speechText && speechText.trim().length > 0;
  const bubbleOffsetBase = Math.max(24, headOffsetPx);

  return (
    <pixiContainer
      x={x}
      y={y}
      eventMode="static"
      onPointerDown={onClick}
      cursor="pointer"
    >
      {(showSpeech || showThought) && (
        <Bubble
          thoughtText={showThought ? thoughtText : undefined}
          speechText={showSpeech ? speechText : undefined}
          offsetBase={bubbleOffsetBase}
        />
      )}
      {isViewer && <ViewerIndicator />}
      <pixiAnimatedSprite
        ref={ref}
        textures={spriteSheet.animations[direction]}
        animationSpeed={speed}
        anchor-x={0.5}
        anchor-y={0.5}
      />
      {emoji && (
        <pixiText
          x={0}
          y={-24}
          scale-x={-0.8}
          scale-y={0.8}
          text={emoji}
          anchor-x={0.5}
          anchor-y={0.5}
        />
      )}
    </pixiContainer>
  );
};

// Estimate text dimensions for bubble sizing (Pixi v8 compatible)
function estimateTextSize(
  text: string,
  fontSize: number,
  wrapWidth: number,
): { width: number; height: number } {
  const avgCharWidth = fontSize * 0.6;
  const lineHeight = fontSize * 1.3;
  const words = text.split(/\s+/);
  let currentLineWidth = 0;
  let lines = 1;
  let maxLineWidth = 0;

  for (const word of words) {
    const wordWidth = word.length * avgCharWidth;
    if (currentLineWidth + wordWidth > wrapWidth && currentLineWidth > 0) {
      lines++;
      maxLineWidth = Math.max(maxLineWidth, currentLineWidth);
      currentLineWidth = wordWidth + avgCharWidth;
    } else {
      currentLineWidth += wordWidth + avgCharWidth;
    }
  }
  maxLineWidth = Math.max(maxLineWidth, currentLineWidth);

  return {
    width: Math.min(maxLineWidth, wrapWidth),
    height: lines * lineHeight,
  };
}

function Bubble({
  thoughtText,
  speechText,
  offsetBase,
}: {
  thoughtText?: string;
  speechText?: string;
  offsetBase: number;
}) {
  const wrapWidth = 180;
  const fontSize = 12;

  const thoughtStyle = useMemo(
    () =>
      new PIXI.TextStyle({
        fontFamily: "VCR OSD Mono",
        fontSize,
        fill: 0x9ca3af,
        fontStyle: "italic",
        wordWrap: true,
        wordWrapWidth: wrapWidth,
      }),
    [],
  );
  const speechStyle = useMemo(
    () =>
      new PIXI.TextStyle({
        fontFamily: "VCR OSD Mono",
        fontSize,
        fill: 0xffffff,
        wordWrap: true,
        wordWrapWidth: wrapWidth,
      }),
    [],
  );

  const thoughtSize = useMemo(
    () =>
      thoughtText ? estimateTextSize(thoughtText, fontSize, wrapWidth) : null,
    [thoughtText],
  );
  const speechSize = useMemo(
    () =>
      speechText ? estimateTextSize(speechText, fontSize, wrapWidth) : null,
    [speechText],
  );

  const maxWidth = Math.max(thoughtSize?.width ?? 0, speechSize?.width ?? 0);
  const padding = 6;
  const innerWidth = Math.max(80, maxWidth);
  const thoughtHeight = thoughtSize?.height ?? 0;
  const speechHeight = speechSize?.height ?? 0;
  const gap = thoughtText && speechText ? 6 : 0;
  const width = innerWidth + padding * 2;
  const height = thoughtHeight + speechHeight + gap + padding * 2;
  const offsetY = offsetBase + height + 6;
  const background = 0x3b2f2f;
  const outline = 0xb45309;

  const draw = useCallback(
    (g: PIXI.Graphics) => {
      g.clear();
      g.lineStyle(2, outline, 1);
      g.beginFill(background, 0.95);
      g.drawRoundedRect(-width / 2, -offsetY, width, height, 6);
      g.endFill();
    },
    [height, offsetY, width],
  );

  return (
    <pixiContainer>
      <pixiGraphics draw={draw} />
      {thoughtText && (
        <pixiText
          text={thoughtText}
          style={thoughtStyle}
          x={-width / 2 + padding}
          y={-offsetY + padding}
        />
      )}
      {speechText && (
        <pixiText
          text={speechText}
          style={speechStyle}
          x={-width / 2 + padding}
          y={-offsetY + padding + thoughtHeight + gap}
        />
      )}
    </pixiContainer>
  );
}

function ViewerIndicator() {
  const draw = useCallback((g: PIXI.Graphics) => {
    g.clear();
    g.beginFill(0xffff0b, 0.5);
    g.drawRoundedRect(-10, 10, 20, 10, 100);
    g.endFill();
  }, []);

  return <pixiGraphics draw={draw} />;
}

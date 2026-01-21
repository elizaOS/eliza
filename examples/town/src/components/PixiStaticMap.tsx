import * as PIXI from "pixi.js";
import { useEffect, useRef } from "react";
import * as campfire from "../../data/animations/campfire.json";
import * as gentlesparkle from "../../data/animations/gentlesparkle.json";
import * as gentlesplash from "../../data/animations/gentlesplash.json";
import * as gentlewaterfall from "../../data/animations/gentlewaterfall.json";
import * as windmill from "../../data/animations/windmill.json";
import type { AnimatedSprite, WorldMapData } from "../../shared/types";

const animations: Record<
  string,
  { spritesheet: PIXI.SpritesheetData; url: string }
> = {
  "campfire.json": {
    spritesheet: campfire,
    url: "/assets/spritesheets/campfire.png",
  },
  "gentlesparkle.json": {
    spritesheet: gentlesparkle,
    url: "/assets/spritesheets/gentlesparkle32.png",
  },
  "gentlewaterfall.json": {
    spritesheet: gentlewaterfall,
    url: "/assets/spritesheets/gentlewaterfall32.png",
  },
  "windmill.json": {
    spritesheet: windmill,
    url: "/assets/spritesheets/windmill.png",
  },
  "gentlesplash.json": {
    spritesheet: gentlesplash,
    url: "/assets/spritesheets/gentlewaterfall32.png",
  },
};

export function PixiStaticMap({ map }: { map: WorldMapData }) {
  const containerRef = useRef<PIXI.Container | null>(null);

  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const buildMap = async () => {
      container.removeChildren();

      const numxtiles = Math.floor(map.tileSetDimX / map.tileDim);
      const numytiles = Math.floor(map.tileSetDimY / map.tileDim);
      const baseTexture = (await PIXI.Assets.load(map.tileSetUrl)) as
        | PIXI.Texture
        | undefined;
      if (
        cancelled ||
        !baseTexture ||
        typeof baseTexture !== "object" ||
        !("source" in baseTexture) ||
        !baseTexture.source
      ) {
        return;
      }
      baseTexture.source.scaleMode = "nearest";
      const tiles: PIXI.Texture[] = [];
      for (let x = 0; x < numxtiles; x++) {
        for (let y = 0; y < numytiles; y++) {
          tiles[x + y * numxtiles] = new PIXI.Texture({
            source: baseTexture.source,
            frame: new PIXI.Rectangle(
              x * map.tileDim,
              y * map.tileDim,
              map.tileDim,
              map.tileDim,
            ),
          });
        }
      }
      const screenxtiles = map.bgTiles[0].length;
      const screenytiles = map.bgTiles[0][0].length;

      const allLayers = [...map.bgTiles, ...map.objectTiles];

      // blit bg & object layers of map onto canvas
      for (let i = 0; i < screenxtiles * screenytiles; i++) {
        const x = i % screenxtiles;
        const y = Math.floor(i / screenxtiles);
        const xPx = x * map.tileDim;
        const yPx = y * map.tileDim;

        // Add all layers of backgrounds.
        for (const layer of allLayers) {
          const tileIndex = layer[x][y];
          // Some layers may not have tiles at this location.
          if (tileIndex === -1) continue;
          const ctile = new PIXI.Sprite(tiles[tileIndex]);
          ctile.x = xPx;
          ctile.y = yPx;
          container.addChild(ctile);
        }
      }

      const spritesBySheet = new Map<string, AnimatedSprite[]>();
      for (const sprite of map.animatedSprites) {
        const sheet = sprite.sheet;
        if (!spritesBySheet.has(sheet)) {
          spritesBySheet.set(sheet, []);
        }
        spritesBySheet.get(sheet)?.push(sprite);
      }
      for (const [sheet, sprites] of spritesBySheet.entries()) {
        const animation = animations[sheet];
        if (!animation) {
          console.error("Could not find animation", sheet);
          continue;
        }
        const { spritesheet, url } = animation;
        const sheetTexture = (await PIXI.Assets.load(url)) as
          | PIXI.Texture
          | undefined;
        if (
          cancelled ||
          !sheetTexture ||
          typeof sheetTexture !== "object" ||
          !("source" in sheetTexture) ||
          !sheetTexture.source
        ) {
          continue;
        }
        sheetTexture.source.scaleMode = "nearest";
        const spriteSheet = new PIXI.Spritesheet(sheetTexture, spritesheet);
        await spriteSheet.parse();
        if (cancelled) {
          return;
        }
        for (const sprite of sprites) {
          const pixiAnimation = spriteSheet.animations[sprite.animation];
          if (!pixiAnimation) {
            console.error("Failed to load animation", sprite);
            continue;
          }
          const pixiSprite = new PIXI.AnimatedSprite(pixiAnimation);
          pixiSprite.animationSpeed = 0.1;
          pixiSprite.autoUpdate = true;
          pixiSprite.x = sprite.x;
          pixiSprite.y = sprite.y;
          pixiSprite.width = sprite.w;
          pixiSprite.height = sprite.h;
          container.addChild(pixiSprite);
          pixiSprite.play();
        }
      }

      container.x = 0;
      container.y = 0;

      // Set the hit area manually to ensure `pointerdown` events are delivered to this container.
      container.eventMode = "static";
      container.hitArea = new PIXI.Rectangle(
        0,
        0,
        screenxtiles * map.tileDim,
        screenytiles * map.tileDim,
      );
    };

    void buildMap();

    return () => {
      cancelled = true;
      container.removeChildren();
    };
  }, [map]);

  return <pixiContainer ref={containerRef} />;
}

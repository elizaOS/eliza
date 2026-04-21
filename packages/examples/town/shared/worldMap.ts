import {
  animatedsprites,
  bgtiles,
  mapheight,
  mapwidth,
  objmap,
  tiledim,
  tilesetpath,
  tilesetpxh,
  tilesetpxw,
} from "../data/gentle.js";
import type { WorldMapData } from "./types";

export const defaultWorldMap: WorldMapData = {
  width: mapwidth,
  height: mapheight,
  tileSetUrl: tilesetpath,
  tileSetDimX: tilesetpxw,
  tileSetDimY: tilesetpxh,
  tileDim: tiledim,
  bgTiles: bgtiles,
  objectTiles: objmap,
  animatedSprites: animatedsprites,
};

const WATER_SPRITE_SHEETS = new Set<string>([
  "gentlewaterfall.json",
  "gentlesplash.json",
]);
const WATER_SCAN_RADIUS_TILES = 2;
const WATER_BG_TILE_IDS = buildWaterTileIds(WATER_SCAN_RADIUS_TILES);

export function isWalkableTile(x: number, y: number): boolean {
  if (
    x < 0 ||
    y < 0 ||
    x >= defaultWorldMap.width ||
    y >= defaultWorldMap.height
  ) {
    return false;
  }
  if (isWaterTile(x, y)) {
    return false;
  }
  for (const layer of defaultWorldMap.objectTiles) {
    const tileIndex = layer[x]?.[y];
    if (tileIndex === undefined) {
      return false;
    }
    if (tileIndex !== -1) {
      return false;
    }
  }
  return true;
}

function isWaterTile(x: number, y: number): boolean {
  if (WATER_BG_TILE_IDS.size === 0) {
    return false;
  }
  for (const layer of defaultWorldMap.bgTiles) {
    const tileIndex = layer[x]?.[y];
    if (tileIndex === undefined || tileIndex === -1) {
      continue;
    }
    if (WATER_BG_TILE_IDS.has(tileIndex)) {
      return true;
    }
  }
  return false;
}

function buildWaterTileIds(radius: number): Set<number> {
  const waterTiles = new Set<number>();
  const tileDim = defaultWorldMap.tileDim;
  const sprites = defaultWorldMap.animatedSprites.filter((sprite) =>
    WATER_SPRITE_SHEETS.has(sprite.sheet),
  );
  for (const sprite of sprites) {
    const tileX = Math.round(sprite.x / tileDim);
    const tileY = Math.round(sprite.y / tileDim);
    for (let dx = -radius; dx <= radius; dx += 1) {
      for (let dy = -radius; dy <= radius; dy += 1) {
        const x = tileX + dx;
        const y = tileY + dy;
        if (
          x < 0 ||
          y < 0 ||
          x >= defaultWorldMap.width ||
          y >= defaultWorldMap.height
        ) {
          continue;
        }
        for (const layer of defaultWorldMap.bgTiles) {
          const tileIndex = layer[x]?.[y];
          if (tileIndex === undefined || tileIndex === -1) {
            continue;
          }
          waterTiles.add(tileIndex);
        }
      }
    }
  }
  return waterTiles;
}

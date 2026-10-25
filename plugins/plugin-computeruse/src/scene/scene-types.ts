/**
 * Scene representation produced by the WS6 scene-builder pipeline.
 *
 * One `Scene` describes the agent's full visual + structural context at a
 * single moment. It is the contract WS7 (Brain) consumes to ground every
 * coordinate-bearing action.
 *
 * All bbox coordinates are LOCAL to their `displayId`. WS5's
 * `localToGlobal` / `globalToLocal` translate to the input-driver space
 * before any click fires.
 */

import type { DisplayDescriptor, WindowInfo } from "../types.js";

export interface SceneAppWindow {
  id: string;
  title: string;
  bounds: [number, number, number, number];
  displayId: number;
}

export interface SceneApp {
  name: string;
  pid: number;
  windows: SceneAppWindow[];
}

export interface SceneFocusedWindow {
  app: string;
  pid: number | null;
  bounds: [number, number, number, number];
  title: string;
  displayId: number;
}

export interface SceneOcrBox {
  /** Stable id `t<displayId>-<seq>`. */
  id: string;
  text: string;
  bbox: [number, number, number, number];
  conf: number;
  displayId: number;
}

export interface SceneAxNode {
  id: string;
  role: string;
  label?: string;
  bbox: [number, number, number, number];
  actions: string[];
  displayId: number;
}

export interface SceneVlmElement {
  id: string;
  kind: string;
  desc: string;
  bbox: [number, number, number, number];
  displayId: number;
}

export interface Scene {
  timestamp: number;
  displays: DisplayDescriptor[];
  focused_window: SceneFocusedWindow | null;
  apps: SceneApp[];
  ocr: SceneOcrBox[];
  ax: SceneAxNode[];
  /** Set by WS7's Brain when a VLM turn runs; `null` outside agent turns. */
  vlm_scene: string | null;
  vlm_elements: SceneVlmElement[] | null;
}

/**
 * Window-info alias retained for completeness; the scene-builder also accepts
 * the existing `WindowInfo` shape and folds it into `SceneAppWindow`.
 */
export type SceneWindowInfo = WindowInfo;

export type BackgroundKind = "svg-filtered-clouds" | "solid";

export interface BackgroundState {
  reducedMotion: boolean;
  width: number;
  height: number;
}

export interface BackgroundHandle {
  update(state: Partial<BackgroundState>): void;
  unmount(): void;
}

export interface BackgroundModule {
  id: string;
  kind: BackgroundKind;
  fpsBudget: number;
  mount(target: HTMLElement): BackgroundHandle;
}

export const SKY_BACKGROUND_COLOR = "#1d91e8";

export const SKY_BACKGROUND_CSS = `background-color: ${SKY_BACKGROUND_COLOR};`;

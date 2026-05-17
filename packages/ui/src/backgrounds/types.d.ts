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
export declare const SKY_BACKGROUND_COLOR = "#1d91e8";
export declare const SKY_BACKGROUND_CSS = "background-color: #1d91e8;";
//# sourceMappingURL=types.d.ts.map
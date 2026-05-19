export type DetachedShellTab = "browser" | "chat" | "release" | "triggers" | "plugins" | "cloud";
export type ShellRoute = {
    mode: "main";
} | {
    mode: "settings";
    tab?: string;
} | {
    mode: "surface";
    tab: DetachedShellTab;
};
export declare function parseShellRoute(search: string): ShellRoute;
//# sourceMappingURL=shell-params.d.ts.map
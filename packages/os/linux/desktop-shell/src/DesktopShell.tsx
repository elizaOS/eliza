import type { ReactNode } from "react";
import { TopBar } from "./components/TopBar";
import { Wallpaper } from "./components/Wallpaper";

export interface DesktopShellProps {
  companionBar?: ReactNode;
  cloudsModule?: ReactNode;
  children?: ReactNode;
}

export function DesktopShell({
  companionBar,
  cloudsModule,
  children,
}: DesktopShellProps) {
  return (
    <div
      className="elizaos-shell-root"
      style={{ position: "relative", width: "100%", height: "100%" }}
    >
      <Wallpaper cloudsModule={cloudsModule} />
      <div
        className="elizaos-shell-content"
        style={{
          position: "relative",
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <TopBar />
        <main className="elizaos-shell-main" style={{ flex: 1, position: "relative" }}>
          {children}
        </main>
        <div
          className="elizaos-shell-companion-anchor"
          style={{
            position: "absolute",
            bottom: 24,
            left: 0,
            right: 0,
            display: "flex",
            justifyContent: "center",
            pointerEvents: "none",
          }}
        >
          <div style={{ pointerEvents: "auto" }}>{companionBar ?? null}</div>
        </div>
      </div>
    </div>
  );
}

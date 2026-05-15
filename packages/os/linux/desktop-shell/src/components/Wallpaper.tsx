import type { ReactNode } from "react";

export interface WallpaperProps {
  cloudsModule?: ReactNode;
  children?: ReactNode;
}

export function Wallpaper({ cloudsModule, children }: WallpaperProps) {
  return (
    <div
      className="elizaos-shell-wallpaper"
      style={{
        position: "absolute",
        inset: 0,
        background:
          "linear-gradient(180deg, #7fc4ff 0%, #a8d8ff 55%, #d6eaff 100%)",
        overflow: "hidden",
      }}
      aria-hidden="true"
    >
      {cloudsModule ?? null}
      {children ?? null}
    </div>
  );
}

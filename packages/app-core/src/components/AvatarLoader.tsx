interface AvatarLoaderProps {
  /** Sub-label text below the progress bar */
  label?: string;
  /** When true, renders as a full-screen loader instead of an overlay */
  fullScreen?: boolean;
  /** When true, fades the loader out (use before unmounting) */
  fadingOut?: boolean;
}

export function AvatarLoader({
  label = "Initializing entity",
  fullScreen = false,
  fadingOut = false,
}: AvatarLoaderProps) {
  return (
    <div
      style={{
        position: fullScreen ? "fixed" : "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: fullScreen ? "var(--bg)" : "transparent",
        zIndex: 10,
        opacity: fadingOut ? 0 : 1,
        transition: "opacity 0.8s ease-out",
        pointerEvents: fadingOut ? "none" : "auto",
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-start",
          gap: 12,
          width: 280,
        }}
      >
        {/* LOADING label */}
        <div
          style={{
            fontFamily: "var(--mono, monospace)",
            fontSize: 12,
            fontWeight: 400,
            letterSpacing: "0.35em",
            textTransform: "uppercase",
            color: "var(--text)",
            userSelect: "none",
          }}
        >
          LOADING
          <span className="loading-screen__dots" />
        </div>

        {/* Progress bar */}
        <div
          style={{
            width: "100%",
            height: 3,
            background: "var(--bg-accent)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: "60%",
              height: "100%",
              background: "var(--text-strong)",
              boxShadow: "0 0 8px rgba(255, 255, 255, 0.3)",
              animation: "avatar-loader-progress 2s ease-in-out infinite",
            }}
          />
        </div>

        {/* Sub label */}
        <div
          style={{
            fontFamily: "var(--mono, monospace)",
            fontSize: 10,
            fontWeight: 400,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            color: "var(--muted)",
            userSelect: "none",
          }}
        >
          {label}
        </div>
      </div>
    </div>
  );
}

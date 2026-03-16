interface AvatarLoaderProps {
  /** Sub-label text below the progress bar */
  label?: string;
  /** When true, renders as a full-screen loader instead of an overlay */
  fullScreen?: boolean;
}

export function AvatarLoader({
  label = "Initializing entity",
  fullScreen = false,
}: AvatarLoaderProps) {
  return (
    <div
      style={{
        position: fullScreen ? "fixed" : "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: fullScreen ? "#0c0e14" : "transparent",
        zIndex: 10,
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
            color: "rgba(255, 255, 255, 0.7)",
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
            background: "rgba(255, 255, 255, 0.1)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: "60%",
              height: "100%",
              background: "rgba(255, 255, 255, 0.85)",
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
            color: "rgba(255, 255, 255, 0.3)",
            userSelect: "none",
          }}
        >
          {label}
        </div>
      </div>
    </div>
  );
}

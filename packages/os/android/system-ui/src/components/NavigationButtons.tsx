export interface NavigationButtonsProps {
  onBack?: () => void;
  onHome?: () => void;
  onRecents?: () => void;
}

export function NavigationButtons({
  onBack,
  onHome,
  onRecents,
}: NavigationButtonsProps) {
  return (
    <nav
      className="elizaos-mobile-nav"
      role="navigation"
      aria-label="System navigation"
      style={{
        display: "flex",
        justifyContent: "space-around",
        alignItems: "center",
        height: 48,
        background: "rgba(6, 19, 31, 0.85)",
        color: "#fff",
      }}
    >
      <button
        type="button"
        className="elizaos-mobile-nav-btn elizaos-mobile-nav-back"
        aria-label="Back"
        onClick={onBack}
      >
        <span aria-hidden="true">{"◁"}</span>
      </button>
      <button
        type="button"
        className="elizaos-mobile-nav-btn elizaos-mobile-nav-home"
        aria-label="Home"
        onClick={onHome}
      >
        <span aria-hidden="true">{"○"}</span>
      </button>
      <button
        type="button"
        className="elizaos-mobile-nav-btn elizaos-mobile-nav-recents"
        aria-label="Recents"
        onClick={onRecents}
      >
        <span aria-hidden="true">{"□"}</span>
      </button>
    </nav>
  );
}

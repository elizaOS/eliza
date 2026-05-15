import { useSystemProvider } from "../../providers/context";

export function SettingsButton() {
  const { controls } = useSystemProvider();
  return (
    <button
      type="button"
      className="elizaos-shell-indicator elizaos-shell-settings-btn"
      aria-label="Open settings"
      title="Settings"
      onClick={() => controls.openSettings()}
    >
      <span aria-hidden="true">{"⚙"}</span>
    </button>
  );
}

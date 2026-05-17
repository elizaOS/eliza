import { useSystemProvider } from "../../providers/context";

export function CellSignal() {
  const { cell } = useSystemProvider();
  if (!cell) {
    return null;
  }
  if (cell.airplaneMode) {
    return (
      <span
        className="elizaos-mobile-icon elizaos-mobile-cell"
        role="img"
        aria-label="Airplane mode"
      >
        {"✈"}
      </span>
    );
  }
  const label = `${cell.carrier ?? "Cell"} ${cell.strengthBars}/5`;
  return (
    <span
      className="elizaos-mobile-icon elizaos-mobile-cell"
      role="img"
      aria-label={label}
    >
      <span className="elizaos-mobile-cell-bars" aria-hidden="true">
        {"█".repeat(cell.strengthBars)}
        {"░".repeat(5 - cell.strengthBars)}
      </span>
    </span>
  );
}

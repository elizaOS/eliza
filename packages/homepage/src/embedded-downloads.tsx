/** Exposes the Eliza downloads page inside the unified web shell. */
import { EmbeddedMarketingSurface } from "./embedded-surface";
import DownloadsPage from "./pages/marketing";

export default function EmbeddedDownloadsPage(): React.JSX.Element {
  return (
    <EmbeddedMarketingSurface>
      <DownloadsPage />
    </EmbeddedMarketingSurface>
  );
}

/** Exposes the approved Eliza landing page inside the unified web shell. */

import { EmbeddedMarketingSurface } from "./embedded-surface";
import LandingPage from "./pages/landing";

export default function EmbeddedHomePage(): React.JSX.Element {
  return (
    <EmbeddedMarketingSurface>
      <LandingPage />
    </EmbeddedMarketingSurface>
  );
}

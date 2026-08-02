/**
 * Deterministic catalog adapter for the real home-screen launcher fixture.
 *
 * Both launcher data hooks consume the same synthetic view registry so a
 * production refactor between hook surfaces cannot silently change the fixture
 * from a representative launcher into a one-tile catalog.
 */

import { viewToEntry } from "../../../hooks/view-catalog";
import { useRoutableViews } from "./home-screen-fixture.views-stub";

export function useViewCatalog() {
  const { views } = useRoutableViews();
  return {
    entries: views.map(viewToEntry),
    loading: false,
    error: null,
    refresh: () => {},
    get: async () => {},
  };
}

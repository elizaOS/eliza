/** Shared navigation names for installed registry entries; these names grant no authority. */
export function viewNavigationAliases(view: { id: string }): readonly string[] {
  return view.id === "chat"
    ? ["home"]
    : view.id === "automations"
      ? ["workflows"]
      : [];
}

/** The caller supplies the already role/availability-filtered registry. Ambiguity stays explicit. */
export function resolveViewNavigationTargets<
  T extends { id: string; label: string },
>(
  views: readonly T[],
  target: string,
): Array<{ view: T; resolvedAlias?: string }> {
  const name = target.trim().toLowerCase();
  return views.flatMap((view) => {
    if (view.id.toLowerCase() === name || view.label.toLowerCase() === name)
      return [{ view }];
    const resolvedAlias = viewNavigationAliases(view).find(
      (alias) => alias === name,
    );
    return resolvedAlias ? [{ view, resolvedAlias }] : [];
  });
}

/** Authoritative destination vocabulary for Stage 1 and egress; never caller-supplied aliases. */
export function viewNavigationDestination(view: { id: string; label: string }) {
  const aliases = viewNavigationAliases(view);
  return {
    id: view.id,
    label: view.label,
    ...(aliases.length ? { aliases } : {}),
  };
}

/** Hosted availability or a registry-owned native counterpart; a delivery marker adds no view. */
export function viewNavigationAvailable(
  view: { available?: boolean; nativeOs?: boolean },
  completedAction: boolean,
): boolean {
  return (
    view.available !== false || (completedAction && view.nativeOs === true)
  );
}

/** Conservative complete navigation commands; matching grants no execution authority. */
export function resolveExplicitRegisteredViewRequest<
  T extends { id: string; label: string },
>(
  views: readonly T[],
  text: string,
): { view: T; resolvedAlias?: string } | undefined {
  // "Open my calendar, please." names the Calendar view as plainly as "open
  // calendar"; without the possessive and trailing please it took the
  // planner path (two extra model calls, live 2026-10-30 tj-f923be42254f79).
  const request = text
    .trim()
    .replace(/[.!]+$/u, "")
    .replace(/,?\s+please$/iu, "")
    .trim();
  const command =
    /^(?:please\s+)?(?:open|show|go(?:\s+to)?)\s+(?:(?:the|my)\s+)?(.+)$/iu.exec(
      request,
    );
  if (!command) return;
  const matches = resolveViewNavigationTargets(views, command[1]);
  return matches.length === 1 ? matches[0] : undefined;
}

/** A complete relative navigation command; the caller must supply trusted history. */
export function isExplicitBackViewRequest(text: string): boolean {
  return /^(?:please\s+)?(?:go\s+)?back[.!]*$/iu.test(text.trim());
}

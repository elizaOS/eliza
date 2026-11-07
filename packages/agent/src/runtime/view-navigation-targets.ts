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

/** Leading acknowledgements that request nothing themselves ("Okay, cool. ..."). */
const LEADING_ACKNOWLEDGEMENTS =
  /^(?:(?:ok(?:ay)?|cool|alright|all\s+right|yeah|yes|yep|sure|great|nice|perfect|thanks|thank\s+you|it['’]?s\s+(?:ok(?:ay)?|fine|alright)|hey|um+|uh+|oh)[\s,.!]+)+/iu;
/** The polite request form; its question mark belongs to that form. */
const POLITE_REQUEST =
  /^(?:please[\s,]+)?(?:can|could|would|will)\s+you\s+(?:please[\s,]+)?/iu;
/**
 * A spoken one-view command is short; the longest live form was 39 characters.
 * This route runs on every client chat turn, and the end-anchored courtesy and
 * punctuation patterns cost quadratic time on long runs (about 1-8 s for a
 * 100 KB message), so longer text keeps the planner path without scanning.
 */
const MAX_EXPLICIT_COMMAND_LENGTH = 160;

/**
 * The command left once leading acknowledgements, the polite request form and
 * trailing courtesy are removed. Whatever remains must still be one complete
 * command, so negation, conditions, restrictions and added work keep the
 * planner path, and an unframed "Open notes?" stays a question. Spoken turns
 * arrive as "Can you open the calendar?" or "Okay, cool. Can you go home?";
 * Stage 1 chose direct navigation for each, but without a match no VIEWS
 * candidate was added and every one ran the planner and evaluator for a
 * single view switch (live 2026-10-31 direct stage tj-41061eccc66d0e,
 * tj-41f9d4af5a0266, tj-6efbf84c684459; about 1 s each on direct Cerebras,
 * about 3 s on Cloud).
 */
function explicitCommandText(text: string): string {
  const request = text.trim();
  if (request.length > MAX_EXPLICIT_COMMAND_LENGTH) return "";
  const unacknowledged = request.replace(LEADING_ACKNOWLEDGEMENTS, "");
  const polite = POLITE_REQUEST.exec(unacknowledged);
  return unacknowledged
    .slice(polite?.[0].length ?? 0)
    .replace(polite ? /[.!?]+$/u : /[.!]+$/u, "")
    .replace(/(?:,?\s+(?:please|for\s+me))+$/iu, "")
    .trim();
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
  const command =
    /^(?:please\s+)?(?:open|show(?:\s+me)?|go(?:\s+to)?)\s+(?:(?:the|my)\s+)?(.+)$/iu.exec(
      explicitCommandText(text),
    );
  if (!command) return;
  const matches = resolveViewNavigationTargets(views, command[1]);
  return matches.length === 1 ? matches[0] : undefined;
}

/** A complete relative navigation command; the caller must supply trusted history. */
export function isExplicitBackViewRequest(text: string): boolean {
  return /^(?:please\s+)?(?:go\s+)?back$/iu.test(explicitCommandText(text));
}

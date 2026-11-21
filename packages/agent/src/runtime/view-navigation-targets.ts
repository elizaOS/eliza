/** Shared navigation names for installed registry entries; these names grant no authority. */
export function viewNavigationAliases(view: {
  id: string;
  navigationAliases?: readonly string[];
}): readonly string[] {
  const builtin =
    view.id === "chat"
      ? ["home"]
      : view.id === "automations"
        ? ["workflows"]
        : [];
  return view.navigationAliases?.length
    ? [...builtin, ...view.navigationAliases]
    : builtin;
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

/**
 * The view a free-text destination names, if any: "the settings page", "my
 * calendar" and "Notes" name the Settings, Calendar and Notes views. Matching
 * ignores availability and role: a view name is never a place to travel to.
 */
export function namesRegisteredView<T extends { id: string; label: string }>(
  views: readonly T[],
  target: string,
): boolean {
  const name = target
    .trim()
    .replace(/[\s.!?]+$/u, "")
    .replace(/^(?:the|my|your)\s+/iu, "")
    .replace(/\s+(?:page|screen|view|tab|app)$/iu, "");
  return resolveViewNavigationTargets(views, name).length > 0;
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

/** An enrolled device's view profile narrows destinations by id or alias; no profile keeps all. */
export function viewEnabledByProfile(
  view: { id: string },
  enabled: readonly string[] | undefined,
): boolean {
  return (
    !enabled ||
    enabled.includes(view.id) ||
    viewNavigationAliases(view).some((alias) => enabled.includes(alias))
  );
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

function explicitViewTarget(command: string): string | undefined {
  return /^(?:please\s+)?(?:open|show(?:\s+me)?|go(?:\s+to)?)\s+(?:(?:the|my)\s+)?(.+)$/iu.exec(
    command,
  )?.[1];
}

/** Conservative complete navigation commands; matching grants no execution authority. */
export function resolveExplicitRegisteredViewRequest<
  T extends { id: string; label: string },
>(
  views: readonly T[],
  text: string,
): { view: T; resolvedAlias?: string } | undefined {
  const target = explicitViewTarget(explicitCommandText(text));
  if (!target) return;
  const matches = resolveViewNavigationTargets(views, target);
  return matches.length === 1 ? matches[0] : undefined;
}

/** Recognize an independent leading view command and a separate affirmative read. */
export function resolveCompoundRegisteredViewRequest<
  T extends { id: string; label: string },
>(
  views: readonly T[],
  text: string,
): { view: T; followUp: string } | undefined {
  // Use only a plain conjunction. Conditions, ordering, quoted instructions
  // and multiple follow-ups need the ordinary interpretation path.
  const [opening, followUp, anotherClause] =
    explicitCommandText(text).split(/,?\s+and\s+/iu);
  if (
    !followUp ||
    anotherClause !== undefined ||
    /[.!?;:"“”‘]|(?:^|\s)'|'(?:\s|$)/u.test(`${opening} ${followUp}`) ||
    /\b(?:if|unless|until|before|after|once|when|only|not|never|no|without|instead|otherwise|rather|whether|except|avoid|first|then|but|or)\b|n['’]t/iu.test(
      followUp,
    )
  )
    return;
  const read =
    /^(?:show(?:\s+me)?|read|find|search|look\s+up|list|check|tell\s+me)\s+(.+)$/iu.exec(
      followUp,
    );
  if (!read || namesRegisteredView(views, read[1])) return;
  const target = explicitViewTarget(opening);
  if (!target) return;
  const matches = resolveViewNavigationTargets(views, target);
  if (matches.length === 1) return { view: matches[0].view, followUp };
  if (matches.length > 1) return;

  // A spoken name may combine a registered alias with its own canonical
  // label, as in "mail inbox". Both words must agree on one destination.
  const pair = /^(.+)\s+(\S+)$/u.exec(target);
  if (!pair) return;
  const aliases = resolveViewNavigationTargets(views, pair[1]);
  const labels = resolveViewNavigationTargets(views, pair[2]);
  if (
    aliases.length === 1 &&
    aliases[0].resolvedAlias &&
    labels.length === 1 &&
    !labels[0].resolvedAlias &&
    aliases[0].view.id === labels[0].view.id
  )
    return { view: labels[0].view, followUp };
}

/** A complete relative navigation command; the caller must supply trusted history. */
export function isExplicitBackViewRequest(text: string): boolean {
  return /^(?:please\s+)?(?:go\s+)?back$/iu.test(explicitCommandText(text));
}

/**
 * A complete request for the foreground page's own history or load state:
 * Back, Forward, reload or stop. Where the foreground view keeps page history
 * (Browser), these act on its tab, never on app view navigation.
 */
export function isForegroundPageHistoryRequest(text: string): boolean {
  return /^(?:please\s+)?(?:(?:go\s+)?(?:back|forward)|(?:reload|refresh)(?:\s+(?:the|this)\s+page)?|stop\s+loading(?:\s+(?:the|this)\s+page)?)$/iu.test(
    explicitCommandText(text),
  );
}

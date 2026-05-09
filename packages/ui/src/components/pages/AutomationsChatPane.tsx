/**
 * AutomationsChatPane — thin wrapper around PageScopedChatPane that
 * configures it for the automations surface. Replaces the deleted
 * AutomationRoomChatPane (~700 LOC of bespoke composer/transcript code)
 * with a configuration of the shared chat pane primitive.
 *
 * Used as the in-shell chat sidebar in AutomationsFeed so users can say
 * "make me a workflow that emails my Gmail digests" without leaving the
 * page.
 */

import { PageScopedChatPane } from "./PageScopedChatPane";

export interface AutomationsChatPaneProps {
  className?: string;
  /** Optional title override (defaults to PageScope copy). */
  title?: string;
  /** Optional placeholder override. */
  placeholder?: string;
}

export function AutomationsChatPane({
  className,
  title,
  placeholder,
}: AutomationsChatPaneProps) {
  return (
    <PageScopedChatPane
      scope="page-automations"
      className={className}
      title={title}
      placeholderOverride={placeholder}
    />
  );
}

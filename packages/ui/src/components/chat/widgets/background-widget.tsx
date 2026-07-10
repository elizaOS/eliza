/**
 * In-chat background picker widget for the `[BACKGROUND]` marker. Renders the
 * shared `BackgroundSettingsControls` filmstrip inside the standard chat widget
 * shell so "change my background" yields a live wallpaper picker in the
 * transcript. The controls drive the same persisted `BackgroundConfig`
 * (`useBackgroundConfig`) the Background view and the always-mounted
 * `AppBackground` layer share, so a pick applies globally and instantly — this
 * is one of the only two background surfaces (chat + Settings) since the
 * launcher long-press picker was removed.
 *
 * The shell mounts expanded (the picker's job — pick a wallpaper — has no
 * terminal "complete" state, so `complete` stays false and it never
 * auto-collapses; the chevron still collapses it manually).
 */

import { useAppSelector } from "../../../state";
import { BackgroundSettingsControls } from "../../settings/BackgroundSettingsControls";
import { ChatWidgetShell } from "./chat-widget-shell";

export function BackgroundWidget() {
  const t = useAppSelector((s) => s.t);
  return (
    <ChatWidgetShell
      testId="inline-background"
      complete={false}
      icon={<span className="text-sm">{"🎨"}</span>}
      title={t("messagecontent.BackgroundWidgetTitle", {
        defaultValue: "Background",
      })}
    >
      <div className="py-1.5">
        <BackgroundSettingsControls variant="filmstrip" />
      </div>
    </ChatWidgetShell>
  );
}

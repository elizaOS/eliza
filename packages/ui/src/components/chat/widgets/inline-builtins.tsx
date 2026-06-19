/**
 * Built-in inline chat-reply widgets, registered into the inline-widget
 * registry at module load. Importing this module (a side effect) is what makes
 * `[CHOICE]`, `[FOLLOWUPS]`, and `[FORM]` markers render in chat.
 *
 * Each entry pairs the marker's parser (the parsing semantics) with its React
 * renderer, the same contract a plugin uses via `registerInlineWidget`. The
 * `[TASK]` widget is intentionally NOT here — it is owned and registered by the
 * orchestrator plugin (see `registerTaskWidget` in `./task-widget`).
 */

import { type ChoiceMatch, findChoiceRegions } from "../message-choice-parser";
import {
  type FollowupsMatch,
  findFollowupsRegions,
} from "../message-followups-parser";
import { type FormMatch, findFormRegions } from "../message-form-parser";
import { ChoiceWidget } from "./ChoiceWidget";
import { FollowupsWidget } from "./followups";
import { FormRequest } from "./form-request";
import { registerInlineWidget } from "./inline-registry";

registerInlineWidget<ChoiceMatch>({
  kind: "choice",
  parse: (text) => findChoiceRegions(text).map((m) => ({ ...m, data: m })),
  keyFor: (m) => `choice:${m.id}`,
  render: (m, ctx, key) => (
    <ChoiceWidget
      key={key}
      id={m.id}
      scope={m.scope}
      options={m.options}
      allowCustom={m.allowCustom}
      onChoose={ctx.sendAction}
    />
  ),
});

registerInlineWidget<FollowupsMatch>({
  kind: "followups",
  parse: (text) => findFollowupsRegions(text).map((m) => ({ ...m, data: m })),
  keyFor: (m) => `followups:${m.id}`,
  render: (m, ctx, key) => (
    <FollowupsWidget
      key={key}
      id={m.id}
      options={m.options}
      onChoose={ctx.sendAction}
      onNavigate={ctx.navigate}
      onPrompt={ctx.prefillComposer}
    />
  ),
});

registerInlineWidget<FormMatch>({
  kind: "form",
  parse: (text) => findFormRegions(text).map((m) => ({ ...m, data: m })),
  keyFor: (m) => `form:${m.form.id}`,
  render: (m, ctx, key) => (
    <FormRequest key={key} form={m.form} onSubmit={ctx.submitForm} />
  ),
});

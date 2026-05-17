/**
 * Parser for `[CHOICE:<scope>(?: id=<id>)?]\n...lines...\n[/CHOICE]` blocks
 * emitted by agent actions. Lives in its own module so unit tests can
 * exercise the regex/option extraction without pulling the entire
 * `MessageContent` React graph (which transitively imports the runtime).
 */
import type { ChoiceOption } from "./widgets/ChoiceWidget";
export declare const CHOICE_RE: RegExp;
export declare function generateChoiceId(): string;
export declare function parseChoiceBody(body: string): ChoiceOption[];
export interface ChoiceMatch {
  start: number;
  end: number;
  id: string;
  scope: string;
  options: ChoiceOption[];
}
/** Find every CHOICE block in `text` and return their character regions. */
export declare function findChoiceRegions(text: string): ChoiceMatch[];
//# sourceMappingURL=message-choice-parser.d.ts.map

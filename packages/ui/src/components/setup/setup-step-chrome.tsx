/** Renders the canonical divider between sections of a first-run setup step. */
import { Card } from "../ui/card";
import { Separator } from "../ui/separator";

export function SetupStepDivider() {
  return (
    <div className="my-4 flex items-center gap-3">
      <Separator className="flex-1" />
      <Card
        aria-hidden
        variant="accentTile"
        className="size-1.5 shrink-0 rotate-45 p-0"
      />
      <Separator className="flex-1" />
    </div>
  );
}

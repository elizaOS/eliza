/** Renders provider-declared least-privilege choices for connector OAuth. */

import type { ConnectorOAuthCapabilityDeclaration } from "@elizaos/shared/connector-account-catalog";
import { Card } from "../ui/card";
import { Checkbox } from "../ui/checkbox";
import { Label } from "../ui/label";

export interface ConnectorOAuthCapabilityPickerProps {
  capabilities: readonly ConnectorOAuthCapabilityDeclaration[];
  selected: ReadonlySet<string>;
  onChange: (capabilityId: string, selected: boolean) => void;
}

export function ConnectorOAuthCapabilityPicker({
  capabilities,
  selected,
  onChange,
}: ConnectorOAuthCapabilityPickerProps) {
  return (
    <Card asChild variant="transparent" border="subtle" padding="default">
      <fieldset className="grid gap-2 md:grid-cols-2">
        <legend className="px-1 text-xs font-semibold text-muted">
          Requested capabilities
        </legend>
        {capabilities.map((capability) => {
          const inputId = `connector-oauth-capability-${capability.id}`;
          return (
            <div key={capability.id} className="flex items-start gap-2">
              <Checkbox
                id={inputId}
                checked={selected.has(capability.id)}
                onCheckedChange={(value) =>
                  onChange(capability.id, value === true)
                }
              />
              <div className="space-y-0.5">
                <Label htmlFor={inputId} className="text-xs font-medium">
                  {capability.label}
                </Label>
                <p className="text-xs text-muted">
                  {capability.group}: {capability.description}
                </p>
              </div>
            </div>
          );
        })}
      </fieldset>
    </Card>
  );
}

/**
 * RotationStrategyPicker — compact `Select` exposing the four account
 * rotation strategies. Calls `onChange` with the chosen strategy; the
 * caller is responsible for routing that through `client.patchProviderStrategy`.
 */
import type { LinkedAccountProviderId } from "@elizaos/shared";
import type { AccountStrategy } from "../../api/client-agent";

interface RotationStrategyPickerProps {
  providerId: LinkedAccountProviderId;
  value: AccountStrategy | undefined;
  onChange: (strategy: AccountStrategy) => void;
  disabled?: boolean;
}
export declare function RotationStrategyPicker({
  providerId,
  value,
  onChange,
  disabled,
}: RotationStrategyPickerProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=RotationStrategyPicker.d.ts.map

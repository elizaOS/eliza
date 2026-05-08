import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@elizaos/ui";
import type { ConnectorAccountPurpose } from "../../api/client-agent";
import {
  CONNECTOR_ACCOUNT_PURPOSE_OPTIONS,
  getConnectorPurposeOption,
} from "./connector-account-options";

export interface ConnectorAccountPurposeSelectorProps {
  value?: ConnectorAccountPurpose;
  onChange: (value: ConnectorAccountPurpose) => void;
  disabled?: boolean;
  id?: string;
}

export function ConnectorAccountPurposeSelector({
  value,
  onChange,
  disabled = false,
  id,
}: ConnectorAccountPurposeSelectorProps) {
  const resolved = getConnectorPurposeOption(value).value;

  return (
    <div className="flex min-w-[180px] items-center gap-2">
      <span className="shrink-0 text-[10px] font-medium uppercase tracking-wider text-muted">
        Acts as:
      </span>
      <Select
        value={resolved}
        disabled={disabled}
        onValueChange={(next) => {
          if (next !== resolved) onChange(next as ConnectorAccountPurpose);
        }}
      >
        <SelectTrigger
          id={id}
          className="h-8 w-[132px] rounded-lg border border-border bg-card text-xs"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {CONNECTOR_ACCOUNT_PURPOSE_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              <div className="flex flex-col gap-0.5 py-0.5">
                <span className="text-sm font-medium text-txt">
                  {option.label}
                </span>
                <span className="text-xs text-muted">{option.description}</span>
              </div>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

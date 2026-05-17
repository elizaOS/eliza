import type { ConnectorAccountPrivacy } from "../../api/client-agent";
export interface ConnectorAccountPrivacySelectorProps {
    value?: ConnectorAccountPrivacy;
    onChange: (value: ConnectorAccountPrivacy, confirmation?: {
        privacy?: string;
        publicAcknowledged?: boolean;
    }) => Promise<void> | void;
    disabled?: boolean;
    id?: string;
    accountLabel?: string;
}
export declare function ConnectorAccountPrivacySelector({ value, onChange, disabled, id, accountLabel, }: ConnectorAccountPrivacySelectorProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=ConnectorAccountPrivacySelector.d.ts.map
export type ApiKeyStatus = "active" | "inactive" | "expired";
export interface ApiKeyDisplay {
    id: string;
    name: string;
    description?: string | null;
    keyPrefix: string;
    status: ApiKeyStatus;
    lastUsedAt?: string | null;
    createdAt: string;
    permissions: string[];
    usageCount: number;
    rateLimit: number;
    expiresAt?: string | null;
}
export interface ApiKeysTableProps {
    keys: ApiKeyDisplay[];
    onCopyKey?: (id: string) => void;
    onDisableKey?: (id: string) => void;
    onDeleteKey?: (id: string) => void;
    onRegenerateKey?: (id: string) => void;
}
export declare function ApiKeysTable({ keys, onCopyKey, onDisableKey, onDeleteKey, onRegenerateKey, }: ApiKeysTableProps): import("react/jsx-runtime").JSX.Element | null;
//# sourceMappingURL=api-keys-table.d.ts.map
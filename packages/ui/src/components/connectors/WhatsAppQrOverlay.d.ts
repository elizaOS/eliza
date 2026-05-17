interface WhatsAppQrOverlayProps {
    accountId?: string;
    /** Called when QR pairing succeeds — parent should install plugin + close modal. */
    onConnected?: () => void;
    connectedMessage?: string;
}
export declare function WhatsAppQrOverlay({ accountId, onConnected, connectedMessage, }: WhatsAppQrOverlayProps): import("react/jsx-runtime").JSX.Element;
export {};
//# sourceMappingURL=WhatsAppQrOverlay.d.ts.map
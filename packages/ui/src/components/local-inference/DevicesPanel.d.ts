import type { DeviceBridgeStatus } from "../../api/client-local-inference";
/**
 * Multi-device panel. Lists every connected bridge device (desktop +
 * phone + tablet, etc.) ranked by score. The device ranked first is the
 * "primary" — new generate calls route there by default. Devices that
 * drop offline show up greyed-out until they reconnect.
 */
export declare function DevicesPanel({ status, }: {
    status: DeviceBridgeStatus | null;
}): import("react/jsx-runtime").JSX.Element | null;
//# sourceMappingURL=DevicesPanel.d.ts.map
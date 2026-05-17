export type DeviceProfile = "ios" | "android" | "aosp" | "cuda16" | "cuda32" | "mac32" | "ram64" | "low";
export interface DeviceProfileCopy {
    recommendation: string;
    preferLocal: boolean;
}
export declare function deviceProfileCopy(profile: DeviceProfile): DeviceProfileCopy;
//# sourceMappingURL=device-profiles.d.ts.map
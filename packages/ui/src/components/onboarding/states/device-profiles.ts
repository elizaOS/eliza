export type DeviceProfile =
  | "ios"
  | "android"
  | "aosp"
  | "cuda16"
  | "cuda32"
  | "mac32"
  | "ram64"
  | "low";

export interface DeviceProfileCopy {
  recommendation: string;
  preferLocal: boolean;
}

const COPY: Record<DeviceProfile, DeviceProfileCopy> = {
  ios: {
    recommendation:
      "I recommend cloud for your device. Running in the cloud means I have a lot less limitations around what I can do.",
    preferLocal: false,
  },
  android: {
    recommendation:
      "I recommend cloud on Android. Cloud removes the device limitations and keeps everything in sync.",
    preferLocal: false,
  },
  aosp: {
    recommendation:
      "Local is supported on AOSP. Cloud is not the default recommendation here.",
    preferLocal: true,
  },
  cuda16: {
    recommendation:
      "You can comfortably run me on this GPU, or use cloud for the heaviest tasks.",
    preferLocal: true,
  },
  cuda32: {
    recommendation:
      "With 32GB of VRAM I run very well on-device. Local is the strong recommendation.",
    preferLocal: true,
  },
  mac32: {
    recommendation:
      "You have plenty of memory; local works well here. Cloud is also a clean choice.",
    preferLocal: true,
  },
  ram64: {
    recommendation:
      "With 64GB of RAM I have room to stretch out. Local is the strong recommendation.",
    preferLocal: true,
  },
  low: {
    recommendation:
      "This device is below my comfortable local threshold. Cloud will give you the best experience.",
    preferLocal: false,
  },
};

export function deviceProfileCopy(profile: DeviceProfile): DeviceProfileCopy {
  return COPY[profile];
}

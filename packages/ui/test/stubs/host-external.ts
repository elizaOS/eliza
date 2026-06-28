export type CameraDirection = "front" | "back";

export type PhotoResult = {
  base64: string;
  format?: string;
};

export const Camera = {
  requestPermissions: async () => ({ camera: "denied" }),
  startPreview: async () => undefined,
  stopPreview: async () => undefined,
  switchCamera: async () => undefined,
  capturePhoto: async (): Promise<PhotoResult> => ({
    base64: "",
    format: "jpeg",
  }),
};

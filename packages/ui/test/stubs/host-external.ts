/**
 * Test stub for host-external native plugins (camera, …) returning denied/no-op.
 */
export const Camera = {
  async requestPermissions() {
    return { camera: "denied" };
  },
  async startPreview() {},
  async stopPreview() {},
  async switchCamera() {
    return { direction: "back" };
  },
  async capturePhoto() {
    return { base64: "", format: "jpeg" };
  },
};

/** The catalog must never simulate successful native Phone reads. */
export const Phone = {
  async getStatus() {
    throw new Error("Native Phone status is unavailable in the story catalog");
  },
  async listRecentCalls() {
    throw new Error("Native call history is unavailable in the story catalog");
  },
};

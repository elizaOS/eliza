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

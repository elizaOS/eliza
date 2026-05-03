export class CameraManager {
	setSendToWebview(_fn: (message: string, payload?: unknown) => void): void {}

	async getDevices() {
		// Renderer uses navigator.mediaDevices.enumerateDevices() directly
		return { devices: [], available: true };
	}

	async startPreview(_options?: { deviceId?: string }) {
		// Renderer handles getUserMedia directly
		return { available: true };
	}

	async stopPreview() {}

	async switchCamera(_options: { deviceId: string }) {
		return { available: true };
	}

	async capturePhoto() {
		// Renderer captures via canvas.toDataURL()
		return { available: true };
	}

	async startRecording() {
		// Renderer uses MediaRecorder API
		return { available: true };
	}

	async stopRecording() {
		return { available: true };
	}

	async getRecordingState() {
		return { recording: false, duration: 0 };
	}

	async checkPermissions(): Promise<{ status: string }> {
		if (process.platform === "darwin") {
			const { getPermissionManager } = await import("./permissions");
			const state = await getPermissionManager().checkPermission("camera");
			return { status: state.status };
		}
		// Non-macOS: native permission state is unknown; renderer must request via getUserMedia
		return { status: "prompt" };
	}

	async requestPermissions(): Promise<{ status: string }> {
		if (process.platform === "darwin") {
			const { getPermissionManager } = await import("./permissions");
			const state = await getPermissionManager().requestPermission("camera");
			return { status: state.status };
		}
		// Non-macOS: renderer handles permission prompts via getUserMedia
		return { status: "prompt" };
	}

	dispose(): void {}
}

let cameraManager: CameraManager | null = null;

export function getCameraManager(): CameraManager {
	if (!cameraManager) {
		cameraManager = new CameraManager();
	}
	return cameraManager;
}

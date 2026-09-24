/* Executed inside the device WebView. No web shims or mocked native methods. */
(async () => {
  window.nativeContractResult = null;
  let assertions = 0;
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
    assertions++;
  };
  const descriptor = window.nativeDescriptor;
  const call = (method, options = {}) =>
    window.Capacitor.nativePromise(descriptor.name, method, options);
  const rejects = async (method, options = {}) => {
    let rejected = false;
    try {
      await call(method, options);
    } catch {
      rejected = true;
    }
    assert(rejected, `${method} must reject invalid input`);
  };
  assert(window.Capacitor.getPlatform() === "android", "must run on Android");
  assert(
    window.Capacitor.isPluginAvailable(descriptor.name),
    "plugin must register in Capacitor",
  );
  switch (descriptor.directory) {
    case "plugin-native-mobile-agent-bridge": {
      assert(
        (await call("getTunnelStatus")).state === "idle",
        "tunnel starts idle",
      );
      await rejects("startInboundTunnel");
      const invalid = await call("startInboundTunnel", {
        relayUrl: "ftp://invalid.example",
        deviceId: "test-device",
      });
      assert(
        invalid.state === "error" && typeof invalid.lastError === "string",
        "invalid relay is an explicit error",
      );
      await call("stopInboundTunnel");
      assert(
        (await call("getTunnelStatus")).state === "idle",
        "stop clears tunnel error",
      );
      break;
    }
    case "plugin-native-screencapture": {
      const support = await call("isSupported");
      assert(
        support.supported && support.features.includes("screenshot"),
        "screen capture capability crosses bridge",
      );
      const state = await call("getRecordingState");
      assert(
        !state.isRecording &&
          !state.isPaused &&
          state.duration === 0 &&
          state.fileSize === 0,
        "recording starts idle",
      );
      assert(
        (await call("checkPermissions")).screenCapture === "prompt",
        "projection requires user consent",
      );
      await rejects("stopRecording");
      await rejects("pauseRecording");
      await rejects("resumeRecording");
      break;
    }
    case "plugin-native-agent": {
      const status = await call("getStatus");
      assert(
        status.state === "not_started",
        "isolated test APK has no embedded agent service",
      );
      await rejects("start");
      break;
    }
    case "plugin-native-bun-runtime": {
      const status = await call("getStatus");
      assert(
        status.engine === "bun" && status.ready === false,
        "runtime must report unavailable without host service",
      );
      break;
    }
    case "plugin-native-camera": {
      const { devices } = await call("getDevices");
      assert(devices.length > 0, "emulator camera must enumerate");
      assert(
        devices.every((device) => typeof device.deviceId === "string") &&
          devices.some((device) => device.supportedResolutions.length > 0),
        "camera capabilities must cross bridge",
      );
      await call("setSettings", { settings: { flash: "off" } });
      assert(
        (await call("getSettings")).settings.flash === "off",
        "settings round trip",
      );
      await rejects("capturePhoto");
      await call("startPreview", {
        direction: "back",
        resolution: { width: 640, height: 480 },
      });
      try {
        const photo = await call("capturePhoto", {
          format: "png",
          width: 32,
          height: 24,
          saveToGallery: false,
        });
        assert(
          photo.width === 32 && photo.height === 24,
          "native camera capture dimensions",
        );
        const image = new Image();
        await new Promise((resolve, reject) => {
          image.onload = resolve;
          image.onerror = reject;
          image.src = `data:image/png;base64,${photo.base64}`;
        });
        assert(
          image.naturalWidth === 32 && image.naturalHeight === 24,
          "captured pixels must decode in the WebView",
        );
      } finally {
        await call("stopPreview");
      }
      await rejects("capturePhoto");
      break;
    }
    case "plugin-native-canvas": {
      const { canvasId } = await call("create", {
        size: { width: 8, height: 8 },
      });
      try {
        await call("drawRect", {
          canvasId,
          rect: { x: 0, y: 0, width: 8, height: 8 },
          fill: { color: { r: 255, g: 0, b: 0, a: 1 } },
        });
        const pixels = await call("getPixelData", { canvasId });
        const bytes = atob(pixels.data);
        assert(
          pixels.width === 8 && pixels.height === 8 && bytes.length === 256,
          "native canvas dimensions and RGBA bytes",
        );
        assert(
          bytes.charCodeAt(0) === 255 &&
            bytes.charCodeAt(1) === 0 &&
            bytes.charCodeAt(3) === 255,
          "native drawing must produce opaque red pixels",
        );
        const png = await call("toImage", { canvasId, format: "png" });
        assert(png.base64.startsWith("iVBOR"), "native PNG encoding");
      } finally {
        await call("destroy", { canvasId });
      }
      await rejects("getPixelData", { canvasId });
      break;
    }
    case "plugin-native-contacts": {
      const result = await call("listContacts", {
        query: "Eliza-bridge-nonexistent",
        limit: 10,
      });
      assert(Array.isArray(result.contacts), "real contacts provider result");
      await rejects("createContact", { displayName: "" });
      break;
    }
    case "plugin-native-messages": {
      const result = await call("listMessages", { limit: 10 });
      assert(Array.isArray(result.messages), "real SMS provider result");
      await rejects("sendSms", { number: "", body: "" });
      break;
    }
    case "plugin-native-phone": {
      const result = await call("getStatus");
      assert(
        typeof result.hasTelecom === "boolean" &&
          typeof result.isDefaultDialer === "boolean",
        "Android telecom status",
      );
      await rejects("placeCall", { number: "" });
      break;
    }
    case "plugin-native-location": {
      const permissions = await call("checkPermissions");
      assert(
        permissions.location === "granted",
        "test location grant must reach plugin",
      );
      await rejects("getCurrentPosition", { timeout: -1 });
      await rejects("watchPosition", { minDistance: -1 });
      const { watchId } = await call("watchPosition", { minInterval: 1000 });
      assert(
        typeof watchId === "string" && watchId.length > 0,
        "watch must register on AOSP or GMS",
      );
      await call("clearWatch", { watchId });
      await rejects("clearWatch");
      break;
    }
    case "plugin-native-mlkit-text": {
      const canvas = document.createElement("canvas");
      canvas.width = 800;
      canvas.height = 180;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, 800, 180);
      ctx.fillStyle = "black";
      ctx.font = "bold 80px sans-serif";
      ctx.fillText("ELIZA BRIDGE 42", 20, 110);
      const result = await call("recognize", {
        image: canvas.toDataURL("image/png"),
      });
      assert(
        result.words.some((word) => word.text.includes("ELIZA")),
        "ML Kit must recognize WebView-rendered image",
      );
      await rejects("recognize", { image: "not-an-image" });
      break;
    }
    case "plugin-native-network-policy": {
      const result = await call("getMeteredHint");
      assert(result.source === "android-os", "Android network policy source");
      assert(
        result.metered === null || typeof result.metered === "boolean",
        "metered state contract",
      );
      const hints = await call("getPathHints");
      assert(typeof hints.isConstrained === "boolean", "path hints contract");
      break;
    }
    case "plugin-native-wifi": {
      const result = await call("getWifiState");
      assert(
        typeof result.enabled === "boolean" &&
          typeof result.connected === "boolean",
        "native radio state",
      );
      assert(
        result.rssi === null || typeof result.rssi === "number",
        "RSSI result shape",
      );
      break;
    }
    case "plugin-native-system": {
      const status = await call("getStatus");
      assert(
        status.packageName.endsWith(".test") && status.roles.length > 0,
        "native package and Android roles",
      );
      const settings = await call("getDeviceSettings");
      assert(
        settings.volumes.some((volume) => volume.stream === "voiceCall"),
        "Android volume streams",
      );
      assert(
        settings.brightness >= 0 && settings.brightness <= 1,
        "native brightness range",
      );
      break;
    }
    case "plugin-native-mobile-signals": {
      await call("startMonitoring", { emitInitial: false });
      try {
        const result = await call("getSnapshot");
        assert(
          result.supported === true && typeof result.snapshot === "object",
          "native signal snapshot",
        );
      } finally {
        await call("stopMonitoring");
      }
      break;
    }
    case "plugin-native-secure-store": {
      const key = "runtime.active_server";
      try {
        assert(
          (await call("set", { key, value: "test-only-server" })).ok,
          "secure write",
        );
        assert(
          (await call("get", { key })).value === "test-only-server",
          "secure read",
        );
      } finally {
        await call("remove", { key });
      }
      assert(
        (await call("get", { key })).error === "not_found",
        "secure delete",
      );
      break;
    }
    case "plugin-native-swabble": {
      assert(
        (await call("isListening")).listening === false,
        "wake listener starts idle",
      );
      const devices = await call("getAudioDevices");
      assert(
        Array.isArray(devices.devices),
        "Android audio device enumeration",
      );
      await rejects("updateConfig");
      await call("stop");
      break;
    }
    case "plugin-native-talkmode": {
      assert(
        (await call("isEnabled")).enabled === false,
        "talk mode starts disabled",
      );
      assert(
        typeof (await call("getState")).state === "string",
        "talk mode native state",
      );
      assert(
        (await call("isCapturingAudioFrames")).capturing === false,
        "audio capture starts stopped",
      );
      let listener;
      let timer;
      const frame = new Promise((resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("native PCM frame timed out")),
          10000,
        );
        Promise.resolve(
          window.Capacitor.Plugins.TalkMode.addListener("audioFrame", resolve),
        )
          .then((handle) => {
            listener = handle;
          })
          .catch(reject);
      });
      try {
        const started = await call("startAudioFrames", {
          sampleRate: 16000,
          frameMs: 20,
        });
        assert(started.started === true, "Android AudioRecord must start");
        const audio = await frame;
        assert(
          audio.channels === 1 && audio.samples > 0,
          "native microphone frame metadata",
        );
        assert(
          atob(audio.pcm16).length === audio.samples * 2,
          "PCM16 byte count must match sample count",
        );
      } finally {
        clearTimeout(timer);
        await call("stopAudioFrames");
        if (listener) await listener.remove();
      }
      assert(
        (await call("isCapturingAudioFrames")).capturing === false,
        "microphone must stop",
      );
      await call("stop");
      break;
    }
    case "plugin-native-appblocker": {
      const status = await call("getStatus");
      assert(
        status.available === true && status.active === false,
        "fresh app blocking state",
      );
      const apps = await call("getInstalledApps");
      assert(
        Array.isArray(apps.apps) && apps.apps.length > 0,
        "Android package enumeration",
      );
      break;
    }
    case "plugin-native-websiteblocker": {
      const status = await call("getStatus");
      assert(
        status.platform === "android" && status.engine === "vpn-dns",
        "Android VPN implementation",
      );
      assert(status.active === false, "fresh website blocking state");
      assert(Array.isArray(status.blockedWebsites), "block list contract");
      break;
    }
    case "plugin-native-gateway": {
      assert(
        (await call("isConnected")).connected === false,
        "gateway starts disconnected",
      );
      const result = await call("send", { method: "test-only" });
      assert(
        result.ok === false && result.error.code === "NOT_CONNECTED",
        "disconnected send fails explicitly",
      );
      await call("disconnect");
      break;
    }
    case "plugin-native-browser-surface": {
      const identity = { owner: "bridge-test", session: "session-1", epoch: 1 };
      const id = "bridge-surface";
      await rejects("reconcileOwner", {
        ...identity,
        epoch: "1",
        desiredIds: [],
      });
      await rejects("reconcileOwner", {
        ...identity,
        epoch: 1.5,
        desiredIds: [],
      });
      await call("reconcileOwner", { ...identity, desiredIds: [] });
      await call("createSurface", {
        ...identity,
        id,
        process: "shared",
        storage: "shared",
        url: "about:blank",
      });
      try {
        const state = await call("getSurfaceState", { ...identity, id });
        assert(
          state.exists &&
            state.owner === identity.owner &&
            state.session === identity.session,
          "native surface owner round trip",
        );
        await rejects("destroySurface", {
          ...identity,
          session: "wrong-session",
          id,
        });
      } finally {
        await call("destroySurface", { ...identity, id });
      }
      assert(
        (await call("getSurfaceState", { ...identity, id })).exists === false,
        "surface disposal",
      );
      break;
    }
    default:
      throw new Error(
        `Missing native bridge scenario: ${descriptor.directory}`,
      );
  }
  window.nativeContractResult = JSON.stringify({ assertions });
})().catch((error) => {
  window.nativeContractResult = JSON.stringify({
    error: String(error),
    stack: error.stack,
  });
});

/** Exercises actual Capacitor bridges from the device WebView, including native outputs and invalid-input settlement. */
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
      assert(
        (await call("start")).ok === false,
        "missing host must fail startup explicitly",
      );
      await rejects("stop");
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
        for (const rect of [
          { x: -1, y: 0, width: 1, height: 1 },
          { x: 0, y: -1, width: 1, height: 1 },
          { x: 8, y: 0, width: 1, height: 1 },
          { x: 0, y: 8, width: 1, height: 1 },
          { x: 0, y: 0, width: 0, height: 1 },
          { x: 0, y: 0, width: 1, height: -1 },
        ]) {
          await rejects("getPixelData", { canvasId, rect });
        }
        const clipped = await call("getPixelData", {
          canvasId,
          rect: { x: 7, y: 7, width: 2147483647, height: 2147483647 },
        });
        assert(
          clipped.width === 1 &&
            clipped.height === 1 &&
            atob(clipped.data) === String.fromCharCode(255, 0, 0, 255),
          "oversized pixel region clips without overflow and preserves drawing",
        );
        const png = await call("toImage", { canvasId, format: "png" });
        assert(png.base64.startsWith("iVBOR"), "native PNG encoding");
        window.nativeCanvasEvidence = {
          original: pixels,
          clipped,
          rejectedRegions: 6,
          png: png.base64,
        };
        const canvasStages = [];
        async function nativeImagePixels(stage) {
          const nativeImage = await call("toImage", {
            canvasId,
            format: "png",
          });
          const image = new Image();
          image.src = `data:image/png;base64,${nativeImage.base64}`;
          await image.decode();
          assert(
            image.naturalWidth === nativeImage.width &&
              image.naturalHeight === nativeImage.height,
            "native PNG dimensions agree with receipt",
          );
          const decoder = document.createElement("canvas");
          decoder.width = nativeImage.width;
          decoder.height = nativeImage.height;
          const context = decoder.getContext("2d");
          context.drawImage(image, 0, 0);
          const rgba = context.getImageData(
            0,
            0,
            decoder.width,
            decoder.height,
          ).data;
          canvasStages.push({ stage, ...nativeImage });
          return (x, y) =>
            Array.from(
              rgba.slice(
                (y * decoder.width + x) * 4,
                (y * decoder.width + x) * 4 + 4,
              ),
            );
        }
        function pixelEquals(actual, expected, message, tolerance = 0) {
          assert(
            actual.length === 4 &&
              actual.every(
                (value, index) =>
                  Math.abs(value - expected[index]) <= tolerance,
              ),
            `${message}: ${actual}`,
          );
        }
        const { layerId } = await call("createLayer", {
          canvasId,
          layer: { name: "blue-overlay", visible: true, opacity: 1, zIndex: 1 },
        });
        await call("drawRect", {
          canvasId,
          rect: { x: 0, y: 0, width: 8, height: 8 },
          fill: { color: { r: 0, g: 0, b: 255, a: 1 } },
          drawOptions: { layerId },
        });
        pixelEquals(
          (await nativeImagePixels("layer-visible"))(3, 3),
          [0, 0, 255, 255],
          "visible layer covers base",
        );
        await call("updateLayer", {
          canvasId,
          layerId,
          layer: { visible: false },
        });
        pixelEquals(
          (await nativeImagePixels("layer-hidden"))(3, 3),
          [255, 0, 0, 255],
          "hidden layer exposes base",
        );
        await call("updateLayer", {
          canvasId,
          layerId,
          layer: { visible: true, opacity: 0.5, name: "half-blue" },
        });
        pixelEquals(
          (await nativeImagePixels("layer-opacity"))(3, 3),
          [128, 0, 127, 255],
          "native layer alpha blends with base",
          1,
        );
        const layers = await call("getLayers", { canvasId });
        const layer = layers.layers.find((value) => value.id === layerId);
        assert(
          layer?.name === "half-blue" &&
            layer.visible &&
            Math.abs(layer.opacity - 0.5) < 0.001,
          "layer metadata matches updates",
        );
        await call("deleteLayer", { canvasId, layerId });
        assert(
          !(await call("getLayers", { canvasId })).layers.some(
            (value) => value.id === layerId,
          ),
          "deleted layer disappears",
        );
        await rejects("updateLayer", {
          canvasId,
          layerId,
          layer: { visible: true },
        });
        pixelEquals(
          (await nativeImagePixels("layer-deleted"))(3, 3),
          [255, 0, 0, 255],
          "deleted layer no longer composites",
        );
        await call("clear", { canvasId });
        pixelEquals(
          (await nativeImagePixels("cleared"))(3, 3),
          [0, 0, 0, 0],
          "clear removes base pixels",
        );
        await call("setTransform", {
          canvasId,
          transform: { translateX: 4, translateY: 0 },
        });
        await call("drawRect", {
          canvasId,
          rect: { x: 0, y: 0, width: 2, height: 2 },
          fill: { color: { r: 255, g: 0, b: 0, a: 1 } },
        });
        let sample = await nativeImagePixels("translated");
        pixelEquals(
          sample(0, 0),
          [0, 0, 0, 0],
          "transform leaves original coordinates empty",
        );
        pixelEquals(
          sample(4, 0),
          [255, 0, 0, 255],
          "transform moves native drawing",
        );
        await call("resetTransform", { canvasId });
        await call("drawRect", {
          canvasId,
          rect: { x: 0, y: 0, width: 2, height: 2 },
          fill: { color: { r: 0, g: 255, b: 0, a: 1 } },
        });
        pixelEquals(
          (await nativeImagePixels("transform-reset"))(0, 0),
          [0, 255, 0, 255],
          "reset restores drawing coordinates",
        );
        await call("resize", { canvasId, size: { width: 12, height: 10 } });
        const resized = await call("getPixelData", { canvasId });
        assert(
          resized.width === 12 &&
            resized.height === 10 &&
            atob(resized.data).length === 480,
          "native resize reports exact dimensions and byte length",
        );
        sample = await nativeImagePixels("resized");
        pixelEquals(
          sample(0, 0),
          [0, 255, 0, 255],
          "resize preserves existing pixels",
        );
        pixelEquals(
          sample(11, 9),
          [0, 0, 0, 0],
          "resize initializes added area transparent",
        );
        await call("clear", {
          canvasId,
          rect: { x: 0, y: 0, width: 2, height: 2 },
        });
        sample = await nativeImagePixels("region-cleared");
        pixelEquals(
          sample(0, 0),
          [0, 0, 0, 0],
          "region clear removes selected pixels",
        );
        pixelEquals(
          sample(4, 0),
          [255, 0, 0, 255],
          "region clear preserves other pixels",
        );
        window.nativeCanvasEvidence.stages = canvasStages;
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
      await rejects("sendSms", { address: "", body: "" });
      if (descriptor.smsRole) {
        let receipt;
        if (descriptor.smsRole === "sender") {
          receipt = await call("sendSms", {
            address: `+1555521${descriptor.smsPeerPort}`,
            body: descriptor.smsBody,
          });
          assert(
            typeof receipt.messageId === "string" &&
              receipt.messageId.length > 0,
            "sent SMS must have a real provider receipt",
          );
        }
        let matches = [];
        const deadline = Date.now() + 15000;
        do {
          const inbox = await call("listMessages", { limit: 500 });
          matches = inbox.messages.filter(
            (message) =>
              message.body === descriptor.smsBody &&
              message.type === (descriptor.smsRole === "sender" ? 2 : 1),
          );
          if (matches.length) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        } while (Date.now() < deadline);
        assert(
          matches.length === 1,
          "exactly one actual modem message must be persisted",
        );
        assert(
          matches[0].type === (descriptor.smsRole === "sender" ? 2 : 1),
          "sent/inbox SMS type",
        );
        if (receipt)
          assert(
            receipt.messageId === matches[0].id,
            "receipt must identify the persisted sent row",
          );
        else if (!descriptor.smsLoopback)
          assert(
            matches[0].address.endsWith(descriptor.smsSenderPort),
            "incoming message must come from the local sender emulator",
          );
        window.nativeSmsEvidence = {
          role: descriptor.smsRole,
          receipt,
          messages: matches,
        };
      }
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
      await rejects("listRecentCalls", { limit: 0 });
      await rejects("saveCallTranscript", { callId: "", transcript: "text" });
      const fixture = descriptor.phoneFixture;
      const { calls } = await call("listRecentCalls", {
        number: fixture.number,
      });
      const types = [
        "incoming",
        "outgoing",
        "missed",
        "rejected",
        "blocked",
        "answered_externally",
      ];
      assert(
        calls.length === fixture.ids.length,
        "all seeded calls must cross the bridge",
      );
      calls.forEach((entry, index) => {
        assert(entry.id === fixture.ids[index], "calls must be newest first");
        assert(
          entry.number === fixture.number,
          "number filter must isolate fixture rows",
        );
        assert(
          entry.type === types[index] &&
            entry.rawType === [1, 2, 3, 5, 6, 7][index],
          "call type mapping",
        );
        assert(entry.durationSeconds === entry.rawType * 11, "call duration");
        assert(entry.isNew === (index === 2), "missed-call unread flag");
      });
      const limited = await call("listRecentCalls", {
        number: fixture.number,
        limit: 2,
      });
      assert(
        limited.calls.length === 2 && limited.calls[1].id === fixture.ids[1],
        "explicit call limit",
      );
      const transcript =
        "Caller: Hello 🌍\nAgent: Complete transcript.\n".repeat(300);
      const summary =
        "A Unicode conversation — preserved across plugin recreation.";
      if (!descriptor.recreated) {
        await rejects("saveCallTranscript", {
          callId: fixture.ids[0],
          transcript: "",
        });
        const saved = await call("saveCallTranscript", {
          callId: fixture.ids[0],
          transcript,
          summary,
        });
        assert(
          Number.isInteger(saved.updatedAt) && saved.updatedAt > 0,
          "transcript timestamp",
        );
      }
      const savedCalls = await call("listRecentCalls", {
        number: fixture.number,
      });
      window.nativePhoneEvidence = savedCalls;
      assert(
        savedCalls.calls[0].agentTranscript === transcript,
        "complete persisted transcript must round trip",
      );
      assert(
        savedCalls.calls[0].agentSummary === summary,
        "persisted summary must round trip",
      );
      assert(
        Number.isInteger(savedCalls.calls[0].agentTranscriptUpdatedAt),
        "persisted timestamp must be numeric",
      );
      assert(
        savedCalls.calls[1].agentTranscript == null,
        "transcript must not leak to another call",
      );
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
    case "plugin-native-inference": {
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
      if (Object.hasOwn(descriptor, "expectedMetered")) {
        assert(
          result.metered === descriptor.expectedMetered,
          `live network transition: ${descriptor.networkStage}`,
        );
        window.nativeNetworkEvidence = result;
      }
      assert(
        result.metered === null || typeof result.metered === "boolean",
        "metered state contract",
      );
      const hints = await call("getPathHints");
      assert(
        hints.isExpensive === null && hints.isConstrained === null,
        "Android path hints must remain unknown",
      );
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
      if (descriptor.systemStage) {
        const stage = descriptor.systemStage;
        const expected = descriptor.systemExpected;
        let brightnessReceipt = null;
        let volumeReceipt = null;
        if (stage === "denied" || stage === "revoked") {
          await rejects("setScreenBrightness", { brightness: 0.37 });
        } else if (stage === "granted" || stage === "clamped") {
          brightnessReceipt = await call("setScreenBrightness", {
            brightness: expected.brightnessInput,
          });
          assert(
            Math.abs(brightnessReceipt.brightness - expected.brightness) <
              0.000001,
            "brightness receipt must match the requested native effect",
          );
        }
        if (["granted", "clamped", "revoked"].includes(stage)) {
          await rejects("setVolume", { stream: "invalid", volume: 1 });
          await rejects("setVolume", { stream: "music" });
          volumeReceipt = await call("setVolume", {
            stream: "music",
            volume: expected.volumeInput,
            showUi: false,
          });
          assert(
            volumeReceipt.current === expected.music &&
              volumeReceipt.max === expected.maxMusic,
            "volume receipt must reflect Android AudioManager",
          );
        }
        const actual = await call("getDeviceSettings");
        assert(
          Math.abs(actual.brightness - expected.brightness) < 0.000001,
          "native brightness round trip",
        );
        assert(
          actual.brightnessMode === expected.brightnessMode,
          "native brightness mode",
        );
        assert(
          actual.canWriteSettings === expected.canWriteSettings,
          "live WRITE_SETTINGS permission state",
        );
        assert(
          actual.volumes.find((item) => item.stream === "music").current ===
            expected.music,
          "native music volume round trip",
        );
        window.nativeSystemEvidence = {
          stage,
          brightnessReceipt,
          volumeReceipt,
          settings: actual,
        };
      }
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

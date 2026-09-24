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

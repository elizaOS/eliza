/** Detects a stale native port without replaying any browser command. */
import {
  acknowledgeNativeChunk,
  BridgeError,
  NativeMessageAssembler,
  NativeMessageSender,
} from "./protocol.mjs";

export const NATIVE_LIVENESS_ALARM = "native-liveness";
const HANDSHAKE_TIMEOUT_MS = 30000;
const PONG_TIMEOUT_MS = 15000;

export class NativeConnection {
  constructor({
    browser,
    nativeHost,
    hello,
    onCommand,
    report,
    now = Date.now,
    nonce = () => crypto.randomUUID(),
    setTimer = (callback, milliseconds) => setTimeout(callback, milliseconds),
    clearTimer = (timer) => clearTimeout(timer),
  }) {
    Object.assign(this, {
      browser,
      nativeHost,
      hello,
      onCommand,
      report,
      now,
      nonce,
      setTimer,
      clearTimer,
    });
    this.current = null;
    this.connecting = false;
    this.stopped = false;
  }

  diagnose(error) {
    // A diagnostic storage failure must not prevent transport recovery.
    void Promise.resolve()
      .then(() => this.report(error))
      .catch((failure) => {
        // error-policy:J7 diagnostic persistence failure is surfaced without stopping recovery.
        console.warn(
          "Native connection diagnostic could not be persisted",
          failure,
        );
      });
  }

  async ensureAlarm() {
    const alarm = await this.browser.alarms.get(NATIVE_LIVENESS_ALARM);
    if (alarm?.periodInMinutes !== 0.5)
      await this.browser.alarms.create(NATIVE_LIVENESS_ALARM, {
        delayInMinutes: 0.5,
        periodInMinutes: 0.5,
      });
  }

  async start() {
    this.browser.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === NATIVE_LIVENESS_ALARM)
        void this.check().catch((error) => this.diagnose(error));
    });
    await this.check();
  }

  async check() {
    if (this.stopped) return;
    await this.ensureAlarm();
    const state = this.current;
    if (!state) return this.connect();
    if (state.deadline && this.now() >= state.deadline) {
      this.close(
        state,
        new BridgeError(
          "UNCERTAIN_OUTCOME",
          "Native browser liveness deadline expired.",
        ),
      );
      return this.connect();
    }
    if (state.ready && !state.pendingNonce) {
      state.pendingNonce = this.nonce();
      this.arm(state, PONG_TIMEOUT_MS);
      this.post(state, {
        type: "ping",
        nonce: state.pendingNonce,
        profileId: state.profileId,
      });
    }
  }

  arm(state, milliseconds) {
    if (state.timer) this.clearTimer(state.timer);
    state.deadline = this.now() + milliseconds;
    state.timer = this.setTimer(() => {
      this.close(
        state,
        new BridgeError(
          "UNCERTAIN_OUTCOME",
          "Native browser liveness deadline expired.",
        ),
      );
    }, milliseconds);
  }

  acknowledged(state) {
    if (state.timer) this.clearTimer(state.timer);
    state.timer = null;
    state.deadline = 0;
    state.pendingNonce = null;
  }

  post(state, frame) {
    if (this.current !== state || state.closed)
      throw new BridgeError(
        "UNCERTAIN_OUTCOME",
        "Native transport generation ended.",
      );
    try {
      state.port.postMessage(frame);
    } catch (error) {
      this.close(state, error);
      throw error;
    }
  }

  close(state, error) {
    if (state.closed) return;
    state.closed = true;
    this.acknowledged(state);
    state.sender.close(error);
    if (this.current === state) this.current = null;
    // disconnect() does not fire onDisconnect on the calling endpoint.
    try {
      state.port.disconnect();
    } catch {
      /* Already disconnected. */
    }
    this.diagnose(error);
  }

  async connect() {
    if (this.current || this.connecting || this.stopped) return;
    this.connecting = true;
    try {
      const hello = await this.hello();
      if (this.stopped) return;
      const port = this.browser.runtime.connectNative(this.nativeHost);
      const state = {
        port,
        ready: false,
        closed: false,
        profileId: hello.profileId,
        pendingNonce: this.nonce(),
        deadline: 0,
        timer: null,
        sender: null,
      };
      this.current = state;
      state.sender = new NativeMessageSender((frame) =>
        this.post(state, frame),
      );
      const assembler = new NativeMessageAssembler();
      port.onMessage.addListener((frame) => {
        if (this.current !== state || state.closed) return;
        try {
          if (state.sender.acceptAcknowledgement(frame)) return;
          const message = assembler.accept(frame);
          acknowledgeNativeChunk(frame, (ack) => this.post(state, ack));
          if (!message) return;
          if (message.type === "hello-ack" || message.type === "pong") {
            const expectedType = state.ready ? "pong" : "hello-ack";
            if (
              message.type !== expectedType ||
              !state.pendingNonce ||
              message.nonce !== state.pendingNonce ||
              message.profileId !== state.profileId
            )
              throw new BridgeError(
                "INVALID_REQUEST",
                "Invalid native liveness receipt.",
              );
            this.acknowledged(state);
            state.ready = true;
            return;
          }
          if (!state.ready)
            throw new BridgeError(
              "INVALID_REQUEST",
              "Command arrived before native registration acknowledgement.",
            );
          const isCurrent = () =>
            this.current === state && state.ready && !state.closed;
          void Promise.resolve(
            this.onCommand(message, state.sender, isCurrent),
          ).catch((error) => this.close(state, error));
        } catch (error) {
          this.close(state, error);
        }
      });
      port.onDisconnect.addListener(() => {
        const detail = this.browser.runtime.lastError?.message;
        this.close(
          state,
          new BridgeError(
            "UNCERTAIN_OUTCOME",
            detail || "Native transport disconnected.",
          ),
        );
      });
      this.arm(state, HANDSHAKE_TIMEOUT_MS);
      this.post(state, { ...hello, nonce: state.pendingNonce });
    } catch (error) {
      // Failures before a port exists also recover on the persistent alarm.
      this.diagnose(error);
    } finally {
      this.connecting = false;
    }
  }

  stop() {
    this.stopped = true;
    if (this.current)
      this.close(
        this.current,
        new BridgeError("UNCERTAIN_OUTCOME", "Native transport stopped."),
      );
  }
}

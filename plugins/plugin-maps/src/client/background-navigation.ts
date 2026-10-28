import type { PluginListenerHandle } from "@capacitor/core";

/** Native half of a screen-off navigation session: a host foreground service with an
 * ongoing notification, reached through the host's bridge plugin. The renderer keeps
 * guidance and voice; this only keeps the session alive and reports its notification
 * Stop once. */
export type NavigationBridge = {
  navigationAvailability(): Promise<{
    background: boolean;
    activeSessionId?: string | null;
  }>;
  startNavigation(input: {
    sessionId: string;
    title: string;
    text: string;
  }): Promise<void>;
  updateNavigation(input: {
    sessionId: string;
    title: string;
    text: string;
  }): Promise<{ active: boolean }>;
  stopNavigation(input: { sessionId: string }): Promise<{ stopped: boolean }>;
  addListener(
    name: "navigationStopped",
    listener: (event: { sessionId: string; reason: string }) => void,
  ): Promise<PluginListenerHandle>;
};
type Session = {
  id: string;
  title: string;
  text: string;
  listener?: Promise<PluginListenerHandle>;
  stopped: boolean;
  started: boolean;
  onStopped: (reason: string) => void;
};

export class BackgroundNavigation {
  private session?: Session;
  private readonly bridge: NavigationBridge;
  private readonly native: () => boolean;
  constructor(bridge: NavigationBridge, native: () => boolean) {
    this.bridge = bridge;
    this.native = native;
  }
  /** True while a native session holds navigation alive with the screen off. */
  active() {
    return !!this.session && !this.session.stopped;
  }
  /** Start the native session for an explicit Start. Resolves false where unsupported. */
  async start(
    title: string,
    text: string,
    onStopped: (reason: string) => void,
  ): Promise<boolean> {
    await this.stop();
    if (!this.native()) return false;
    const session: Session = {
      id: crypto.randomUUID().replaceAll("-", ""),
      title,
      text,
      stopped: false,
      started: false,
      onStopped,
    };
    this.session = session;
    try {
      if (!(await this.bridge.navigationAvailability()).background)
        throw new Error("unavailable");
      if (this.session !== session) return false;
      session.listener = this.bridge.addListener(
        "navigationStopped",
        (event) => {
          if (event.sessionId !== session.id || session.stopped) return;
          session.stopped = true;
          if (this.session === session) this.session = undefined;
          void session.listener
            ?.then((handle) => handle.remove())
            .catch(() => {});
          onStopped(event.reason);
        },
      );
      await session.listener;
      if (this.session !== session) return false;
      const shown = { title: session.title, text: session.text };
      await this.bridge.startNavigation({ sessionId: session.id, ...shown });
      if (this.session !== session || session.stopped) return false;
      session.started = true;
      // An instruction that changed while the native session was starting is sent now: before
      // the start resolved, native had no session to update, and that answer is not a loss.
      if (session.title !== shown.title || session.text !== shown.text)
        this.push(session);
      return true;
    } catch {
      if (this.session === session) await this.stop();
      return false;
    }
  }
  /** Mirror the current instruction; unchanged text is not resent. */
  update(title: string, text: string) {
    const session = this.session;
    if (
      !session ||
      session.stopped ||
      (session.title === title && session.text === text)
    )
      return;
    session.title = title;
    session.text = text;
    if (session.started) this.push(session);
  }
  private push(session: Session) {
    const { title, text } = session;
    void this.bridge
      .updateNavigation({ sessionId: session.id, title, text })
      .then(
        (result) => {
          if (result?.active !== true) this.lost(session);
        },
        () => this.lost(session),
      );
  }
  /** A failed readback cannot establish continued native ownership. Retire only
   * the session that issued it; an old response must not stop a newer route. */
  private lost(session: Session) {
    if (this.session !== session || session.stopped) return;
    void this.stop();
    session.onStopped("unavailable");
  }
  /** End the native session from the app. A session already stopped by its notification is not stopped twice. */
  async stop(): Promise<void> {
    const session = this.session;
    this.session = undefined;
    if (!session) return;
    const wasStopped = session.stopped;
    session.stopped = true;
    await Promise.allSettled([
      ...(wasStopped
        ? []
        : [this.bridge.stopNavigation({ sessionId: session.id })]),
      ...(session.listener
        ? [session.listener.then((handle) => handle.remove())]
        : []),
    ]);
  }
}

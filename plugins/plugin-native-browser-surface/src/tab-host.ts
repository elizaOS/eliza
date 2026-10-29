/**
 * The renderer half of the Android `BrowserTabHostPlugin`: its bridge API and
 * a shared session model of the native tabs one host document owns.
 *
 * The model accepts only events for this document's session, in each tab's
 * native sequence order, and only for tabs this document created or the
 * native host opened for it. A document revision changes whenever a tab starts
 * loading or its address changes, so a page binding (for reading, a question
 * about the page, sharing or another browser) taken for one document never
 * authorizes the next. Bindings come from committed native state only, never
 * from page content or caller-supplied text.
 *
 * Hosts own the tab strip, address editor, prompts, persistence and the
 * product's checks around each binding; the model holds no page content.
 * Bridge-free: importing this module registers nothing.
 */

/** Listener handle returned by a Capacitor `addListener`. */
export interface BrowserTabHostListener {
  remove(): Promise<void> | void;
}

/** Native state of one tab as `stateChanged` reports it. */
export interface BrowserTabState {
  readonly session: string;
  readonly id: string;
  /** Increases with every event the native host sends. */
  readonly sequence: number;
  /** Changes with every navigation the native host starts. */
  readonly navigation?: string;
  readonly url?: string;
  readonly title?: string;
  readonly loading?: boolean;
  readonly committed?: boolean;
  readonly httpStatus?: number;
  readonly progress?: number;
  readonly canBack?: boolean;
  readonly canForward?: boolean;
  readonly error?: string;
  readonly private?: boolean;
  /** Set once after the activity resumed: the host should resend geometry. */
  readonly surfaceResumed?: boolean;
  /** A page only another browser can show; it never gains reading authority. */
  readonly externalOnly?: boolean;
}

export interface BrowserTabOpened {
  readonly session: string;
  readonly id: string;
  /** The tab whose tapped link or `window.open` opened this one. */
  readonly opener?: string;
  readonly private?: boolean;
}

export interface BrowserTabEvent {
  readonly session: string;
  readonly id: string;
}

export interface BrowserTabNotice extends BrowserTabEvent {
  readonly message: string;
}

export interface BrowserFindResult extends BrowserTabEvent {
  readonly navigation?: string;
  readonly cleared?: boolean;
  readonly index?: number;
  readonly count?: number;
  readonly done?: boolean;
}

export interface BrowserFullscreen extends BrowserTabEvent {
  readonly active: boolean;
}

/** Geometry of the presented tab in CSS pixels; `id: null` hides every tab. */
export type BrowserTabPresentation =
  | { readonly session: string; readonly id: null }
  | {
      readonly session: string;
      readonly id: string;
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    };

/** The page fields every page-bound native call repeats for its own check. */
export interface BrowserPageGuard {
  readonly session: string;
  readonly id: string;
  readonly url: string;
  readonly navigation: string;
}

/** Speech binding of a reviewed reading (see `BrowserReviewedReading`). */
export type BrowserReadingBinding =
  | {
      readonly execution: "device";
      readonly ownerId: string;
      readonly sessionId: string;
      readonly expiresAt: number;
    }
  | {
      readonly execution?: "remote";
      readonly origin: string;
      readonly ownerId: string;
      readonly sessionId: string;
      readonly expiresAt: number;
    };

export interface BrowserSavedState {
  readonly history: string[];
  readonly tabs: { id: string; url: string; title: string }[];
  readonly cur: string;
}

/** The Capacitor API of an Android `BrowserTabHostPlugin` subclass. */
export interface BrowserTabHostPlugin {
  create(options: {
    session: string;
    id: string;
    private?: boolean;
  }): Promise<BrowserTabState>;
  navigate(options: {
    session: string;
    id: string;
    url: string;
  }): Promise<BrowserTabState>;
  command(options: {
    session: string;
    id: string;
    command: "back" | "forward" | "reload" | "stop";
    /** When given, the command runs only on this exact document in the foreground. */
    navigation?: string;
  }): Promise<BrowserTabState>;
  present(options: BrowserTabPresentation): Promise<void>;
  close(options: { session: string; id: string }): Promise<void>;
  find(options: {
    session: string;
    id: string;
    query: string;
  }): Promise<BrowserTabState>;
  findNext(options: {
    session: string;
    id: string;
    forward?: boolean;
  }): Promise<BrowserTabState>;
  clearFind(options: { session: string; id: string }): Promise<BrowserTabState>;
  bookmarks(options: { session: string }): Promise<{ urls: string[] }>;
  setBookmark(options: {
    session: string;
    url: string;
    saved: boolean;
  }): Promise<{ urls: string[] }>;
  browsingState(options: { session: string }): Promise<BrowserSavedState>;
  /** Normal tabs and history only; never send private tabs. */
  saveBrowsingState(
    options: { session: string } & BrowserSavedState,
  ): Promise<BrowserSavedState>;
  /** Closes every normal tab, then clears the persistent profile. Bookmarks remain. */
  clearBrowsingData(options: {
    session: string;
  }): Promise<{ closed: string[] }>;
  clearSiteData(options: {
    session: string;
    id: string;
    url: string;
  }): Promise<{ site?: string }>;
  readingSupport(): Promise<{ available: boolean }>;
  reviewQuestion(
    options: BrowserPageGuard & Partial<BrowserReadingBinding>,
  ): Promise<{ text: string }>;
  reviewReading(
    options: BrowserPageGuard & BrowserReadingBinding,
  ): Promise<{ readingToken: string }>;
  cancelReading(options: { session: string }): Promise<void>;
  share(options: BrowserPageGuard): Promise<BrowserTabState>;
  openExternalBrowser(
    options: BrowserPageGuard & { privateConfirmed?: boolean },
  ): Promise<void>;
  downloads(options: { session: string }): Promise<void>;
  loginFillStatus(): Promise<{ available: boolean; reason?: string }>;
  addListener(
    event: "stateChanged",
    listener: (event: BrowserTabState) => void,
  ): Promise<BrowserTabHostListener>;
  addListener(
    event: "tabOpened",
    listener: (event: BrowserTabOpened) => void,
  ): Promise<BrowserTabHostListener>;
  addListener(
    event: "tabClosed",
    listener: (event: BrowserTabEvent) => void,
  ): Promise<BrowserTabHostListener>;
  addListener(
    event: "notice",
    listener: (event: BrowserTabNotice) => void,
  ): Promise<BrowserTabHostListener>;
  addListener(
    event: "findResult",
    listener: (event: BrowserFindResult) => void,
  ): Promise<BrowserTabHostListener>;
  addListener(
    event: "fullscreen",
    listener: (event: BrowserFullscreen) => void,
  ): Promise<BrowserTabHostListener>;
}

/** What the model knows about one tab: its last accepted native state plus host fields. */
export interface BrowserTabInfo extends Partial<BrowserTabState> {
  /** The last committed public page, kept while a later load is pending or fails. */
  readonly savedUrl?: string;
}

/** Outcome of an accepted `stateChanged` event. */
export interface BrowserTabStateChange {
  readonly id: string;
  readonly previous: BrowserTabInfo | undefined;
  readonly info: BrowserTabInfo;
  /** The document revision moved: earlier page bindings no longer hold. */
  readonly revisionChanged: boolean;
  /**
   * The document a reading or question was bound to is gone or not settled
   * (loading, failed, another navigation or address).
   */
  readonly documentChanged: boolean;
  /** A committed, settled public page that may enter history (normal tabs only). */
  readonly committedPage: boolean;
  readonly surfaceResumed: boolean;
}

/** A committed page of one tab at one document revision. */
export interface BrowserPageBinding {
  readonly id: string;
  readonly url: string;
  readonly navigation: string;
  readonly revision: number;
  readonly private: boolean;
}

/** Opaque identity of the selected tab's document for an agent proposal. */
export interface BrowserTabSelection {
  readonly kind: "browser-tab";
  readonly id: string;
  readonly revision: string;
}

export interface BrowserTabSessionOptions {
  /** This document's session; a fresh random id when omitted. */
  readonly session?: string;
  /** The native host's tab limit (8 by default). */
  readonly maxTabs?: number;
}

const TAB_ID = /^[A-Za-z0-9_-]{1,80}$/;
const MAX_FIND_COUNT = 100_000;
const MAX_NOTICE = 200;

/** Renderer-chosen tab ids follow the native rule (`BrowserTabHostConfig.validTabId`). */
export function validBrowserTabId(id: unknown): id is string {
  return typeof id === "string" && TAB_ID.test(id);
}

/** A new random renderer tab id. */
export function newBrowserTabId(): string {
  return `b${globalThis.crypto.randomUUID().replace(/-/g, "")}`;
}

/**
 * The native tabs of one host document. Create it once per document and
 * dispose it with the document: native tabs of an ended session are refused.
 */
export class BrowserTabSession {
  readonly session: string;
  readonly maxTabs: number;
  private readonly created = new Map<string, Promise<unknown>>();
  private readonly tabs = new Map<string, BrowserTabInfo>();
  private readonly revisions = new Map<string, number>();
  private readonly privateTabs = new Set<string>();
  private disposed = false;

  constructor(options: BrowserTabSessionOptions = {}) {
    this.session = options.session ?? globalThis.crypto.randomUUID();
    this.maxTabs = options.maxTabs ?? 8;
    if (!this.session || this.session.length > 100)
      throw new Error("Invalid browser session");
    if (!Number.isInteger(this.maxTabs) || this.maxTabs < 1)
      throw new Error("Invalid browser tab limit");
  }

  get closed(): boolean {
    return this.disposed;
  }

  /** Whether the event belongs to this live document. */
  owns(event: { session?: unknown } | null | undefined): boolean {
    return !this.disposed && !!event && event.session === this.session;
  }

  /**
   * The native creation of tab `id`, started once. A failed creation is
   * forgotten so a later call can retry; private-ness is fixed at creation.
   */
  ensure(
    id: string,
    privateTab: boolean,
    create: () => Promise<unknown>,
  ): Promise<unknown> {
    if (this.disposed) return Promise.reject(new Error("Browser closed"));
    if (!validBrowserTabId(id)) return Promise.reject(new Error("Invalid tab"));
    const existing = this.created.get(id);
    if (existing) return existing;
    if (this.created.size >= this.maxTabs)
      return Promise.reject(new Error("Close a tab before opening another."));
    if (privateTab) this.privateTabs.add(id);
    const creation = create().catch((error: unknown) => {
      if (this.created.get(id) === creation) {
        this.created.delete(id);
        this.privateTabs.delete(id);
      }
      throw error;
    });
    this.created.set(id, creation);
    return creation;
  }

  /** The pending or finished creation of `id`, if any. */
  creation(id: string): Promise<unknown> | undefined {
    return this.created.get(id);
  }

  has(id: string | undefined | null): boolean {
    return !!id && this.created.has(id);
  }

  /** Every native tab this document created or was given. */
  ids(): string[] {
    return [...this.created.keys()];
  }

  isPrivate(id: string): boolean {
    return this.privateTabs.has(id) || !!this.tabs.get(id)?.private;
  }

  info(id: string | undefined | null): BrowserTabInfo | undefined {
    return id ? this.tabs.get(id) : undefined;
  }

  revision(id: string | undefined | null): number {
    return (id && this.revisions.get(id)) || 0;
  }

  /** Host fields kept with the tab (for example a restored page's address and title). */
  annotate(id: string, fields: BrowserTabInfo): void {
    if (this.disposed) return;
    this.tabs.set(id, { ...this.tabs.get(id), ...fields });
  }

  /** The renderer asked tab `id` to load `url`: the next document begins now. */
  beginNavigation(id: string, url: string): number {
    this.annotate(id, { url, loading: true, committed: false, error: "" });
    return this.bump(id);
  }

  /** Applies a `stateChanged` event, or returns undefined when it is not for a current tab. */
  applyState(event: BrowserTabState): BrowserTabStateChange | undefined {
    if (!this.owns(event) || !this.created.has(event.id)) return undefined;
    const previous = this.tabs.get(event.id);
    if (
      typeof event.sequence !== "number" ||
      event.sequence <= (previous?.sequence ?? 0)
    )
      return undefined;
    const documentChanged =
      !!event.loading ||
      !!event.error ||
      event.navigation !== previous?.navigation ||
      event.url !== previous?.url;
    const revisionChanged =
      (!!event.url && event.url !== previous?.url) ||
      (!!event.loading && !previous?.loading);
    if (revisionChanged) this.bump(event.id);
    const committedPage =
      !!event.url &&
      !!event.committed &&
      !event.externalOnly &&
      !event.loading &&
      !event.error;
    const info: BrowserTabInfo = {
      ...previous,
      ...event,
      ...(event.externalOnly ? { committed: false } : {}),
      ...(committedPage ? { savedUrl: event.url } : {}),
    };
    this.tabs.set(event.id, info);
    if (event.private) this.privateTabs.add(event.id);
    return {
      id: event.id,
      previous,
      info,
      revisionChanged,
      documentChanged,
      committedPage: committedPage && !this.isPrivate(event.id),
      surfaceResumed: !!event.surfaceResumed,
    };
  }

  /**
   * Accepts a pop-up the native host opened as a tab. Returns its id and
   * privacy, or undefined for another session or a known id. The native host
   * already enforced its tab limit and the tap, so an accepted pop-up is never
   * left without a renderer tab.
   */
  applyOpened(
    event: BrowserTabOpened,
  ): { id: string; private: boolean } | undefined {
    if (
      !this.owns(event) ||
      !validBrowserTabId(event.id) ||
      this.created.has(event.id)
    )
      return undefined;
    this.created.set(event.id, Promise.resolve());
    this.revisions.set(event.id, 1);
    // A pop-up shares its opener's profile: a private opener's child is private.
    const privateTab =
      !!event.private ||
      (event.opener !== undefined && this.isPrivate(event.opener));
    if (privateTab) this.privateTabs.add(event.id);
    return { id: event.id, private: privateTab };
  }

  /** Accepts a native close (window.close, cleared data); returns the id to forget. */
  applyClosed(event: BrowserTabEvent): string | undefined {
    if (!this.owns(event) || !this.created.has(event.id)) return undefined;
    this.forget([event.id]);
    return event.id;
  }

  /** A notice for this document, bounded for display. */
  notice(event: BrowserTabNotice): string | undefined {
    if (!this.owns(event) || typeof event.message !== "string")
      return undefined;
    return event.message.slice(0, MAX_NOTICE);
  }

  /** A find result for the tab whose find bar is open, clamped. */
  findResult(
    event: BrowserFindResult,
    findTab: string | undefined | null,
  ):
    | { cleared: true }
    | { cleared: false; count: number; index: number; done: boolean }
    | undefined {
    if (!this.owns(event) || !findTab || event.id !== findTab) return undefined;
    if (event.cleared) return { cleared: true };
    if (typeof event.count !== "number" || typeof event.index !== "number")
      return undefined;
    const count = Math.max(0, Math.min(event.count, MAX_FIND_COUNT));
    return {
      cleared: false,
      count,
      index: Math.max(0, Math.min(event.index, count)),
      done: !!event.done,
    };
  }

  /** Forgets tabs whose native WebView is gone. */
  forget(ids: Iterable<string>): void {
    for (const id of ids) {
      this.created.delete(id);
      this.tabs.delete(id);
      this.revisions.delete(id);
      this.privateTabs.delete(id);
    }
  }

  /**
   * The committed, settled page of tab `id`, or undefined. With `https` only
   * an HTTPS page binds (reading, questions, another browser).
   */
  pageBinding(
    id: string | undefined | null,
    options: { https?: boolean } = {},
  ): BrowserPageBinding | undefined {
    const info = this.info(id);
    if (
      !id ||
      this.disposed ||
      !this.created.has(id) ||
      !info?.committed ||
      info.loading ||
      info.error ||
      info.externalOnly ||
      !info.url ||
      !info.navigation
    )
      return undefined;
    if (options.https && !info.url.startsWith("https://")) return undefined;
    return {
      id,
      url: info.url,
      navigation: info.navigation,
      revision: this.revision(id),
      private: this.isPrivate(id),
    };
  }

  /**
   * Whether `binding` still names the selected tab's same, settled document.
   * Pass the host's selected tab id; the host adds its own foreground checks.
   */
  current(
    binding: BrowserPageBinding | undefined,
    selected: string | undefined | null,
  ): boolean {
    if (!binding || binding.id !== selected) return false;
    const now = this.pageBinding(binding.id);
    return (
      !!now &&
      now.url === binding.url &&
      now.navigation === binding.navigation &&
      now.revision === binding.revision
    );
  }

  /** The guard fields a page-bound native call carries. */
  guard(binding: BrowserPageBinding): BrowserPageGuard {
    return {
      session: this.session,
      id: binding.id,
      url: binding.url,
      navigation: binding.navigation,
    };
  }

  /** Opaque identity of tab `id`'s document; the URL and content stay out. */
  selection(id: string | undefined | null): BrowserTabSelection | undefined {
    const info = this.info(id);
    if (!id || !info?.url || info.error) return undefined;
    return {
      kind: "browser-tab",
      id: `${this.session}:${id}`,
      revision: String(this.revision(id)),
    };
  }

  /**
   * Ends the session and returns every native tab to close. The native host
   * purges private profiles when their last tab closes; later events are
   * refused.
   */
  dispose(): string[] {
    const ids = this.ids();
    this.disposed = true;
    this.forget(ids);
    return ids;
  }

  private bump(id: string): number {
    const next = (this.revisions.get(id) ?? 0) + 1;
    this.revisions.set(id, next);
    return next;
  }
}

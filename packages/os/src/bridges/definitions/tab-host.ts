// spec/os/browser/tabHost/document.md, "Story: Keep my tab's page and privacy stable"; spec/os/browser/tabHost/document.md, "Story: Open new tabs and other apps only when I tap"
export interface BrowserTabHostListener {
  remove(): Promise<void> | void;
}

export interface BrowserTabState {
  readonly session: string;
  readonly id: string;
  readonly sequence: number;
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
  readonly surfaceResumed?: boolean;
  readonly externalOnly?: boolean;
}

export interface BrowserTabOpened {
  readonly session: string;
  readonly id: string;
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

export interface BrowserPageGuard {
  readonly session: string;
  readonly id: string;
  readonly url: string;
  readonly navigation: string;
}

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

export type BrowserTabCommand = "back" | "forward" | "reload" | "stop";

export interface BrowserTabHostPlugin {
  create(options: { session: string; id: string; private?: boolean }): Promise<BrowserTabState>;
  navigate(options: { session: string; id: string; url: string }): Promise<BrowserTabState>;
  command(options: { session: string; id: string; command: BrowserTabCommand; navigation?: string }): Promise<BrowserTabState>;
  present(options: BrowserTabPresentation): Promise<void>;
  close(options: { session: string; id: string }): Promise<void>;
  find(options: { session: string; id: string; query: string }): Promise<BrowserTabState>;
  findNext(options: { session: string; id: string; forward?: boolean }): Promise<BrowserTabState>;
  clearFind(options: { session: string; id: string }): Promise<BrowserTabState>;
  bookmarks(options: { session: string }): Promise<{ urls: string[] }>;
  setBookmark(options: { session: string; url: string; saved: boolean }): Promise<{ urls: string[] }>;
  browsingState(options: { session: string }): Promise<BrowserSavedState>;
  saveBrowsingState(options: { session: string } & BrowserSavedState): Promise<BrowserSavedState>;
  clearBrowsingData(options: { session: string }): Promise<{ closed: string[] }>;
  clearSiteData(options: { session: string; id: string; url: string }): Promise<{ site?: string }>;
  readingSupport(): Promise<{ available: boolean }>;
  reviewQuestion(options: BrowserPageGuard & Partial<BrowserReadingBinding>): Promise<{ text: string }>;
  reviewReading(options: BrowserPageGuard & BrowserReadingBinding): Promise<{ readingToken: string }>;
  cancelReading(options: { session: string }): Promise<void>;
  share(options: BrowserPageGuard): Promise<BrowserTabState>;
  openExternalBrowser(options: BrowserPageGuard & { privateConfirmed?: boolean }): Promise<void>;
  downloads(options: { session: string }): Promise<void>;
  loginFillStatus(): Promise<{ available: boolean; reason?: string }>;
  addListener(event: "stateChanged", listener: (event: BrowserTabState) => void): Promise<BrowserTabHostListener>;
  addListener(event: "tabOpened", listener: (event: BrowserTabOpened) => void): Promise<BrowserTabHostListener>;
  addListener(event: "tabClosed", listener: (event: BrowserTabEvent) => void): Promise<BrowserTabHostListener>;
  addListener(event: "notice", listener: (event: BrowserTabNotice) => void): Promise<BrowserTabHostListener>;
  addListener(event: "findResult", listener: (event: BrowserFindResult) => void): Promise<BrowserTabHostListener>;
  addListener(event: "fullscreen", listener: (event: BrowserFullscreen) => void): Promise<BrowserTabHostListener>;
}

export interface BrowserTabInfo extends Partial<BrowserTabState> {
  readonly savedUrl?: string;
}

export interface BrowserTabStateChange {
  readonly id: string;
  readonly previous: BrowserTabInfo | undefined;
  readonly info: BrowserTabInfo;
  readonly revisionChanged: boolean;
  readonly documentChanged: boolean;
  readonly committedPage: boolean;
  readonly surfaceResumed: boolean;
}

export interface BrowserPageBinding {
  readonly id: string;
  readonly url: string;
  readonly navigation: string;
  readonly revision: number;
  readonly private: boolean;
}

export interface BrowserTabSelection {
  readonly kind: "browser-tab";
  readonly id: string;
  readonly revision: string;
}

export type BrowserFindOutcome =
  | { readonly cleared: true }
  | { readonly cleared: false; readonly count: number; readonly index: number; readonly done: boolean };

export interface BrowserTabSessionOptions {
  readonly session?: string;
  readonly maxTabs?: number;
}

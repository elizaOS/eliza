/**
 * Document scanning state for camera surfaces, with no presentation: the multi-page document a
 * person builds from captured or chosen pages, and the review of one captured page.
 *
 * - Pages stay in memory, in the order the person set, and are admitted only as JPEG, PNG or WebP
 *   up to 16 MB each, 64 MB per document and 32 megapixels.
 * - At most one page operation, draft action or export runs at a time; the document reports the
 *   enabled state of every control so a host renders it without re-deriving the rules.
 * - Exports read an immutable snapshot of the pages. A confirmed or unconfirmed export ends
 *   editing; a cancelled, failed or unavailable one leaves the pages editable for a retry.
 * - With autosave (native hosts, where the platform may end the app while a system picker covers
 *   it) every page change is written to the host's draft store, one save at a time and
 *   compare-and-set on the draft revision, so an older draft is never replaced silently. A
 *   confirmed export removes only the draft this document wrote automatically.
 * - Nothing is kept in a photo library, uploaded or handed off implicitly. A captured page reaches
 *   the library only through the explicit Keep of `createScanCapture`, under one stable operation
 *   identity so a retry resolves the same save.
 */
import { type CameraKeepOutcome, captureOperationId } from "./host-ports";

/** Where a reviewed page came from: a capture, a chosen image, or an unsaved scan-mode frame. */
export type ScanSource = "captured" | "selected" | "unsaved";

export const SCAN_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export const SCAN_LIMITS = {
  pages: 20,
  pageBytes: 16 * 1024 * 1024,
  documentBytes: 64 * 1024 * 1024,
  pixels: 32_000_000,
} as const;

/** The image facts the rules need; a browser `Blob` satisfies it. */
export interface ScanImage {
  readonly type: string;
  readonly size: number;
}

/** A refused page or document change. The message is safe to show as is. */
export class ScanDocumentError extends Error {}

/** Whether `image` is an admissible page on its own (type and size). */
export function scanImageAdmitted(image: ScanImage | undefined): boolean {
  return (
    !!image &&
    (SCAN_IMAGE_TYPES as readonly string[]).includes(image.type) &&
    image.size > 0 &&
    image.size <= SCAN_LIMITS.pageBytes
  );
}

/** Throws unless `image` is an admissible page. */
export function admitScanImage(image: ScanImage | undefined): asserts image {
  if (!scanImageAdmitted(image))
    throw new ScanDocumentError(
      "Choose a JPEG, PNG or WebP image up to 16 MB.",
    );
}

/** Throws unless decoded dimensions are positive and at most 32 megapixels. */
export function admitScanDimensions(width: number, height: number): void {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0 ||
    width * height > SCAN_LIMITS.pixels
  )
    throw new ScanDocumentError("Image dimensions are too large.");
}

/** One page of a document; `id` is stable for the page's life so hosts can key previews. */
export interface ScanPage<Image extends ScanImage, Layer> {
  readonly id: number;
  readonly image: Image;
  readonly textLayer?: Layer | null;
}

/** The host's device draft store (for example plugin-files' `createScanDraftStore`). */
export interface ScanDraftPort<Image extends ScanImage, Layer> {
  save(
    pages: Image[],
    revision: string | undefined,
    signal: AbortSignal,
    layers: (Layer | null)[],
  ): Promise<{ revision: string }>;
  read(): Promise<
    | { revision: string; pages: Image[]; textLayers?: (Layer | null)[] }
    | undefined
  >;
  remove(revision: string, signal: AbortSignal): Promise<void>;
}

/** Whether each control may act now. */
export interface ScanDocumentControls {
  addPage: boolean;
  export: boolean;
  /** Per page, in order. */
  pages: {
    earlier: boolean;
    later: boolean;
    edit: boolean;
  }[];
  saveDraft: boolean;
  loadDraft: boolean;
  deleteDraft: boolean;
}

export interface ScanDocumentSnapshot<Image extends ScanImage, Layer> {
  pages: readonly ScanPage<Image, Layer>[];
  busy: boolean;
  exported: boolean;
  closed: boolean;
  /** The draft revision this document last read or wrote, if any. */
  draftRevision?: string;
  /** Whether that draft was written automatically (removed after a confirmed export). */
  autoSaved: boolean;
  controls: ScanDocumentControls;
}

/** Export answer the document understands; the host's exporter may carry more. */
export interface ScanExportResult {
  status: string;
  message: string;
}

/** Statuses after which the same pages may be exported again. */
export function scanExportRetryable(status: string): boolean {
  return ["cancelled", "failed", "unavailable", "too-large"].includes(status);
}

export interface ScanDocumentOptions<Image extends ScanImage, Layer> {
  first?: Image;
  /** The host's draft store; without it draft actions are unavailable. */
  drafts?: ScanDraftPort<Image, Layer>;
  /** Write every page change to the draft store. */
  autosave?: boolean;
  /** Any state changed; hosts re-render from `snapshot()`. */
  changed?(): void;
  /** An autosave failed; pages stay open. */
  autosaveFailed?(error: unknown): void;
}

export interface ScanDocument<Image extends ScanImage, Layer> {
  snapshot(): ScanDocumentSnapshot<Image, Layer>;
  /** Pages in order (an immutable copy). */
  pages(): readonly ScanPage<Image, Layer>[];
  readonly signal: AbortSignal;
  /**
   * Run one page operation, draft action or export exclusively. Returns undefined when another
   * runs, the document is closed or (unless `afterExport`) already exported.
   */
  run<T>(
    task: (signal: AbortSignal) => Promise<T>,
    options?: { afterExport?: boolean },
  ): Promise<T | undefined>;
  /** Append (index undefined) or replace a page after the size rules. Autosaves. */
  put(image: Image, index?: number): ScanPage<Image, Layer>;
  /** Swap a page with its neighbour. Autosaves. */
  move(index: number, delta: -1 | 1): void;
  /** Remove a page; returns it so the host can release its preview. Autosaves. */
  remove(index: number): ScanPage<Image, Layer> | undefined;
  /** Attach text layers (for example from a searchable export review), in page order. */
  setTextLayers(layers: readonly (Layer | null)[]): void;
  /** Export the current page snapshot through the host's exporter. */
  exportPages(
    exporter: (
      pages: Image[],
      layers: (Layer | null)[],
      signal: AbortSignal,
    ) => Promise<ScanExportResult>,
    unconfirmed?: (error: unknown) => boolean,
  ): Promise<ScanExportResult | undefined>;
  /**
   * Record the outcome of an export the host ran itself (for example a searchable review).
   * `editable` says which statuses leave the pages editable; by default the retryable ones and
   * `reviewed` (a review that exported nothing).
   */
  exportFinished(status: string, editable?: (status: string) => boolean): void;
  saveDraft(): Promise<boolean>;
  /** Replace the pages with the saved draft; `confirm` is asked only when pages would be lost. */
  loadDraft(
    confirm: () => boolean | Promise<boolean>,
  ): Promise<"loaded" | "none" | "kept" | undefined>;
  deleteDraft(confirm: () => boolean | Promise<boolean>): Promise<boolean>;
  /** Wait for queued autosaves. */
  settled(): Promise<void>;
  /** Close: abort work, drop pages. Returns the pages that were open. */
  close(): readonly ScanPage<Image, Layer>[];
}

export function createScanDocument<Image extends ScanImage, Layer = unknown>(
  options: ScanDocumentOptions<Image, Layer> = {},
): ScanDocument<Image, Layer> {
  const controller = new AbortController();
  let nextId = 1;
  let pages: ScanPage<Image, Layer>[] = [];
  let busy = false;
  let exported = false;
  let closed = false;
  let draftRevision: string | undefined;
  let autoSaved = false;
  let saving: Promise<void> = Promise.resolve();
  const { drafts } = options;

  const changed = () => {
    try {
      options.changed?.();
    } catch {
      // A host render failure never corrupts document state.
    }
  };
  const total = (except?: number) =>
    pages.reduce(
      (sum, page, i) => sum + (i === except ? 0 : page.image.size),
      0,
    );

  if (options.first) {
    admitScanImage(options.first);
    pages.push({ id: nextId++, image: options.first });
  }

  const autosave = () => {
    if (!options.autosave || !drafts || closed || exported || !pages.length)
      return;
    const images = pages.map((page) => page.image);
    const layers = pages.map((page) => page.textLayer ?? null);
    saving = saving.then(async () => {
      if (closed) return;
      try {
        const draft = await drafts.save(
          images,
          draftRevision,
          controller.signal,
          layers,
        );
        if (closed) return;
        draftRevision = draft.revision;
        autoSaved = true;
        changed();
      } catch (error) {
        if (!closed && !controller.signal.aborted)
          options.autosaveFailed?.(error);
      }
    });
  };

  const settled = async () => {
    try {
      await saving;
    } catch {
      // Each save reports its own failure.
    }
  };

  /** A confirmed export ends the automatic draft this document wrote; a saved or loaded one stays. */
  const clearAutoDraft = async () => {
    await settled();
    if (!drafts || !autoSaved || !draftRevision) return;
    try {
      await drafts.remove(draftRevision, controller.signal);
      if (!closed) {
        draftRevision = undefined;
        autoSaved = false;
        changed();
      }
    } catch {
      // The draft stays; deleting it remains available.
    }
  };

  const controls = (): ScanDocumentControls => {
    const editable = !busy && !exported && !closed;
    return {
      addPage: editable && pages.length < SCAN_LIMITS.pages,
      export: editable && pages.length > 0,
      pages: pages.map((_, index) => ({
        earlier: editable && index > 0,
        later: editable && index < pages.length - 1,
        edit: editable,
      })),
      saveDraft: !!drafts && !busy && !closed && pages.length > 0,
      loadDraft: !!drafts && !busy && !closed,
      deleteDraft: !!drafts && !busy && !closed && !!draftRevision,
    };
  };

  async function run<T>(
    task: (signal: AbortSignal) => Promise<T>,
    runOptions: { afterExport?: boolean } = {},
  ): Promise<T | undefined> {
    if (busy || closed || (exported && !runOptions.afterExport))
      return undefined;
    busy = true;
    changed();
    try {
      return await task(controller.signal);
    } finally {
      if (!closed) {
        busy = false;
        changed();
      }
    }
  }

  const index = (value: number) => {
    if (!Number.isInteger(value) || value < 0 || value >= pages.length)
      throw new ScanDocumentError("That page is no longer in the document.");
    return value;
  };

  function put(image: Image, at?: number): ScanPage<Image, Layer> {
    if (closed || exported)
      throw new ScanDocumentError("This document can no longer change.");
    admitScanImage(image);
    if (at === undefined && pages.length >= SCAN_LIMITS.pages)
      throw new ScanDocumentError("A document holds up to 20 pages.");
    const replaced = at === undefined ? undefined : index(at);
    if (total(replaced) + image.size > SCAN_LIMITS.documentBytes)
      throw new ScanDocumentError("Choose pages up to 64 MB total.");
    const page: ScanPage<Image, Layer> = { id: nextId++, image };
    if (replaced === undefined) pages.push(page);
    else pages[replaced] = page;
    changed();
    autosave();
    return page;
  }

  function move(at: number, delta: -1 | 1) {
    if (closed || exported) return;
    const from = index(at);
    const to = from + delta;
    if (to < 0 || to >= pages.length) return;
    [pages[from], pages[to]] = [pages[to], pages[from]];
    changed();
    autosave();
  }

  function remove(at: number) {
    if (closed || exported) return undefined;
    const [page] = pages.splice(index(at), 1);
    changed();
    autosave();
    return page;
  }

  function setTextLayers(layers: readonly (Layer | null)[]) {
    if (closed || layers.length !== pages.length) return;
    pages = pages.map((page, i) => ({ ...page, textLayer: layers[i] }));
    changed();
    autosave();
  }

  function exportFinished(
    status: string,
    editable: (status: string) => boolean = (value) =>
      scanExportRetryable(value) || value === "reviewed",
  ) {
    if (closed) return;
    exported = !editable(status);
    changed();
    if (status === "exported") void clearAutoDraft();
  }

  async function exportPages(
    exporter: (
      pages: Image[],
      layers: (Layer | null)[],
      signal: AbortSignal,
    ) => Promise<ScanExportResult>,
    unconfirmed: (error: unknown) => boolean = () => false,
  ): Promise<ScanExportResult | undefined> {
    if (!pages.length) return undefined;
    const images = pages.map((page) => page.image);
    const layers = pages.map((page) => page.textLayer ?? null);
    return run(async (signal) => {
      try {
        const result = await exporter(images, layers, signal);
        if (!closed) {
          exported = !scanExportRetryable(result.status);
          if (result.status === "exported") void clearAutoDraft();
        }
        return result;
      } catch (error) {
        // An export whose outcome is unknown ends editing: the file may exist.
        if (!closed && unconfirmed(error)) exported = true;
        throw error;
      }
    });
  }

  async function draftAction<T>(
    action: (store: ScanDraftPort<Image, Layer>) => Promise<T>,
  ): Promise<T | undefined> {
    const store = drafts;
    if (!store) return undefined;
    return run(
      async () => {
        await settled();
        if (closed) return undefined;
        return action(store);
      },
      { afterExport: true },
    );
  }

  return {
    get signal() {
      return controller.signal;
    },
    snapshot: () => ({
      pages: pages.slice(),
      busy,
      exported,
      closed,
      draftRevision,
      autoSaved,
      controls: controls(),
    }),
    pages: () => pages.slice(),
    run,
    put,
    move,
    remove,
    setTextLayers,
    exportPages,
    exportFinished,
    async saveDraft() {
      const done = await draftAction(async (store) => {
        if (!pages.length) return false;
        const draft = await store.save(
          pages.map((page) => page.image),
          draftRevision,
          controller.signal,
          pages.map((page) => page.textLayer ?? null),
        );
        if (closed) return false;
        draftRevision = draft.revision;
        autoSaved = false;
        return true;
      });
      return done === true;
    },
    async loadDraft(confirm) {
      return draftAction(async (store) => {
        const draft = await store.read();
        if (closed) return undefined;
        if (!draft) return "none" as const;
        if (pages.length && !(await confirm())) return "kept" as const;
        if (closed) return undefined;
        for (const image of draft.pages) admitScanImage(image);
        pages = draft.pages.map((image, i) => ({
          id: nextId++,
          image,
          textLayer: draft.textLayers?.[i],
        }));
        draftRevision = draft.revision;
        autoSaved = false;
        exported = false;
        return "loaded" as const;
      });
    },
    async deleteDraft(confirm) {
      const done = await draftAction(async (store) => {
        if (!draftRevision || !(await confirm())) return false;
        await store.remove(draftRevision, controller.signal);
        if (closed) return false;
        draftRevision = undefined;
        autoSaved = false;
        return true;
      });
      return done === true;
    },
    settled,
    close() {
      if (closed) return [];
      closed = true;
      controller.abort();
      const open = pages;
      pages = [];
      changed();
      return open;
    },
  };
}

/** The host's explicit Keep of one captured page (for example into its owned-media store). */
export type ScanKeepPort<Image> = (
  image: Image,
  operationId: string,
  signal: AbortSignal,
) => Promise<CameraKeepOutcome>;

export type ScanKeepState = "idle" | "keeping" | "saved" | "failed" | "unknown";

/**
 * Review of one scanned page. A scan-mode capture is held in memory only (`unsaved`); Keep is the
 * only path to the host's library, under one operation identity for the capture: a retry after a
 * lost or unknown answer resolves the same save, and only a definite failure starts a new
 * identity. Closing aborts a Keep in flight; its outcome is the host store's to resolve.
 */
export interface ScanCapture<Image> {
  readonly image: Image;
  readonly source: ScanSource;
  readonly state: ScanKeepState;
  readonly closed: boolean;
  /** Whether Keep is offered: an unsaved capture with a host Keep port. */
  readonly canKeep: boolean;
  keep(): Promise<CameraKeepOutcome | undefined>;
  close(): void;
}

export function createScanCapture<Image>(
  image: Image,
  source: ScanSource,
  keepPort?: ScanKeepPort<Image>,
  changed?: () => void,
): ScanCapture<Image> {
  const controller = new AbortController();
  let operationId = captureOperationId();
  let state: ScanKeepState = "idle";
  let closed = false;
  const notify = () => {
    try {
      changed?.();
    } catch {
      // Presentation failures never move the keep state.
    }
  };
  return {
    image,
    source,
    get state() {
      return state;
    },
    get closed() {
      return closed;
    },
    get canKeep() {
      return source === "unsaved" && !!keepPort && !closed && state !== "saved";
    },
    async keep() {
      if (
        !keepPort ||
        source !== "unsaved" ||
        closed ||
        state === "keeping" ||
        state === "saved"
      )
        return undefined;
      state = "keeping";
      notify();
      let outcome: CameraKeepOutcome;
      try {
        const answer = await keepPort(image, operationId, controller.signal);
        outcome =
          answer?.status === "saved" || answer?.status === "failed"
            ? answer
            : {
                status: "unknown",
                message:
                  typeof answer?.message === "string" && answer.message
                    ? answer.message
                    : "Keeping this page could not be confirmed. Check the library before trying again.",
              };
      } catch (error) {
        outcome = {
          status: "unknown",
          message:
            error instanceof Error && error.message
              ? error.message
              : "Keeping this page could not be confirmed. Check the library before trying again.",
        };
      }
      state = outcome.status;
      // The store kept nothing for that identity; the next Keep is a new save.
      if (outcome.status === "failed") operationId = captureOperationId();
      notify();
      return outcome;
    },
    close() {
      if (closed) return;
      closed = true;
      controller.abort();
      notify();
    },
  };
}

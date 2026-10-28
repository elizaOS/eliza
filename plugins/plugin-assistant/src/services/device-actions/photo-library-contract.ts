/** Device photo/video library contract for agent tools over the full permitted library (the
 * Android catalog in plugin-native-media PermittedMediaCatalog and a host's own paged library).
 * Dependency-free, so hosts and tests can use the rules anywhere; the bounds mirror the host's
 * native library reader.
 *
 * The local agent may use every photo and video Android lets the app read. Full local access is
 * not an upload: the catalog stays on the phone, metadata sent to a model excludes file and
 * album names, and pixels leave only through an owner-reviewed Android share. Owner-facing text
 * names the app through an `appName` argument; hosts pass their product name. */

export type LibraryScope =
  | "full"
  | "partial"
  | "selected"
  | "denied"
  | "unavailable";
export type LibraryKind = "image" | "video";
export type LibraryScopeState = {
  scope: LibraryScope;
  images: boolean;
  videos: boolean;
  canSelectMore: boolean;
  canEditOthers: boolean;
  locked: boolean;
  version: string;
  settingsRequired?: boolean;
  imageAccess?: "full" | "selected" | "denied";
  videoAccess?: "full" | "selected" | "denied";
};
export type LibraryItem = {
  id: string;
  revision: string;
  kind: LibraryKind;
  mime: string;
  name: string;
  album: string;
  width: number;
  height: number;
  takenAt: number;
  modifiedAt: number;
  size: number;
  duration: number;
  favorite: boolean;
  owned: boolean;
  image?: string;
};
export type LibraryPage = {
  scope: LibraryScopeState;
  items: LibraryItem[];
  next: string;
  generation: number;
};
export type LibraryValidation = {
  id: string;
  status: "current" | "changed" | "missing";
  item?: LibraryItem;
};

/** Native bounds of the host's library reader. */
export const LIBRARY_LIMITS = Object.freeze({
  page: 100,
  thumbnailRows: 30,
  validate: 200,
  changes: 200,
  action: 20,
  query: 80,
  kept: 2000,
  thumbnailsKept: 240,
});
export const LIBRARY_ID = /^lib:([iv]):([1-9][0-9]{0,18}):([0-9]{1,19})$/;
const PERMITTED_ID = /^m:([a-zA-Z0-9_-]{1,80}):([iv]):([1-9][0-9]{0,18})$/;
const PERMITTED_REVISION = /^[a-zA-Z0-9_-]{1,128}(?::[0-9]{1,19}){3,5}$/;
const validRevision = (value: string) =>
  REVISION.test(value) || PERMITTED_REVISION.test(value);
const REVISION = /^[0-9]{1,19}:[0-9]{1,19}(?::[0-9]{1,19})?$/;

type Bag = Record<string, unknown>;
const bag = (value: unknown): Bag => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid library response");
  return value as Bag;
};
/** A non-negative metric. An absent field reads as 0 (unknown); a present but malformed value
 * (a string, NaN, Infinity or a negative number) rejects the row instead of becoming 0. */
const metric = (value: unknown, field: string) => {
  if (value === undefined) return 0;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0)
    return value;
  throw Error(`Invalid library ${field}`);
};
const short = (value: unknown, max = 255) =>
  typeof value === "string" ? value.slice(0, max) : "";

export function isLibraryId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (LIBRARY_ID.test(value) ||
      (PERMITTED_ID.test(value) && !/^m:(external|internal):/.test(value)))
  );
}
export function libraryKindOf(id: string): LibraryKind {
  const permitted = PERMITTED_ID.exec(id);
  if (permitted && isLibraryId(id))
    return permitted[2] === "v" ? "video" : "image";
  const match = LIBRARY_ID.exec(id);
  if (!match) throw Error("Invalid library id");
  return match[1] === "v" ? "video" : "image";
}

export function parseScope(value: unknown): LibraryScopeState {
  const row = bag(value);
  const scope =
    row.scope === "full" ||
    row.scope === "partial" ||
    row.scope === "selected" ||
    row.scope === "denied"
      ? row.scope
      : undefined;
  if (!scope) throw Error("Invalid library scope");
  return {
    scope,
    ...(typeof row.imageAccess === "string" &&
    ["full", "selected", "denied"].includes(row.imageAccess)
      ? { imageAccess: row.imageAccess as "full" | "selected" | "denied" }
      : {}),
    ...(typeof row.videoAccess === "string" &&
    ["full", "selected", "denied"].includes(row.videoAccess)
      ? { videoAccess: row.videoAccess as "full" | "selected" | "denied" }
      : {}),
    images: row.images === true,
    videos: row.videos === true,
    canSelectMore: row.canSelectMore === true,
    canEditOthers: row.canEditOthers === true,
    locked: row.locked === true,
    version: short(row.version, 128),
    ...(row.settingsRequired === true ? { settingsRequired: true } : {}),
  };
}

export function parseItem(value: unknown): LibraryItem {
  const row = bag(value);
  if (
    !isLibraryId(row.id) ||
    typeof row.revision !== "string" ||
    !validRevision(row.revision)
  )
    throw Error("Invalid library item");
  const kind = libraryKindOf(row.id);
  if (row.kind !== kind) throw Error("Library item kind mismatch");
  const image =
    typeof row.image === "string" &&
    (row.image === "" || row.image.startsWith("data:image/jpeg;base64,"))
      ? row.image
      : undefined;
  return {
    id: row.id,
    revision: row.revision,
    kind,
    mime: short(row.mime, 128),
    name: short(row.name),
    album: short(row.album),
    width: metric(row.width, "width"),
    height: metric(row.height, "height"),
    takenAt: metric(row.takenAt, "takenAt"),
    modifiedAt: metric(row.modifiedAt, "modifiedAt"),
    size: metric(row.size, "size"),
    duration: metric(row.duration, "duration"),
    favorite: row.favorite === true,
    owned: row.owned === true,
    ...(image !== undefined ? { image } : {}),
  };
}

export function parsePage(value: unknown): LibraryPage {
  const row = bag(value);
  if (!Array.isArray(row.items) || row.items.length > LIBRARY_LIMITS.page)
    throw Error("Invalid library page");
  const next =
    typeof row.next === "string" &&
    (row.next === "" ||
      /^[1-9][0-9]{0,18}$/.test(row.next) ||
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        row.next,
      ))
      ? row.next
      : undefined;
  if (next === undefined) throw Error("Invalid library cursor");
  const items = row.items.map(parseItem);
  if (new Set(items.map((item) => item.id)).size !== items.length)
    throw Error("Duplicate library item");
  return {
    scope: parseScope(row),
    items,
    next,
    generation: metric(row.generation, "generation"),
  };
}

export function parseValidation(value: unknown): LibraryValidation[] {
  const row = bag(value);
  if (!Array.isArray(row.items) || row.items.length > LIBRARY_LIMITS.validate)
    throw Error("Invalid validation");
  return row.items.map((entry) => {
    const item = bag(entry);
    if (
      !isLibraryId(item.id) ||
      !["current", "changed", "missing"].includes(String(item.status))
    )
      throw Error("Invalid validation row");
    const status = item.status as LibraryValidation["status"];
    if (status === "changed") {
      const fresh = parseItem(item.item);
      if (fresh.id !== item.id) throw Error("Validation id mismatch");
      return { id: item.id, status, item: fresh };
    }
    return { id: item.id, status };
  });
}

/** Default product name in owner-facing text; hosts pass their own. */
export const LIBRARY_APP_NAME = "the app";
const sentence = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

/** Honest copy for what Android granted. Nothing here claims more than the scope. */
export function scopePresentation(
  state: LibraryScopeState | undefined,
  appName: string = LIBRARY_APP_NAME,
): {
  label: string;
  detail: string;
  action: string;
  actionKind: "request" | "settings" | "none";
} {
  const boundary = `Nothing is uploaded automatically: the assistant receives only reviewed search or inspection results, without file or album names. Locked Folder, other profiles and work-profile media are not visible to ${appName}.`;
  if (!state || state.scope === "unavailable")
    return {
      label: "Unavailable",
      detail: "The device library is available only in the Android app.",
      action: "",
      actionKind: "none",
    };
  if (state.locked)
    return {
      label: "Locked",
      detail: "Unlock the phone to use the device library.",
      action: "",
      actionKind: "none",
    };
  if (state.scope === "partial")
    return {
      label: "Mixed access",
      detail: `Photos: ${state.imageAccess || (state.images ? "full" : "denied")}. Videos: ${state.videoAccess || (state.videos ? "full" : "denied")}. ${boundary}`,
      action: "Change in Android Settings",
      actionKind: "settings",
    };
  if (state.scope === "full") {
    const partial =
      state.images !== state.videos
        ? state.images
          ? " Videos are not allowed."
          : " Photos are not allowed."
        : "";
    return {
      label: "Full access",
      detail:
        `${sentence(appName)} can read the photos and videos Android shows for this profile.` +
        partial +
        " " +
        boundary,
      action: "Change in Android Settings",
      actionKind: "settings",
    };
  }
  if (state.scope === "selected")
    return {
      label: "Selected items",
      detail:
        `Android allows only the items you chose. Other photos and videos are not visible to ${appName}. ` +
        boundary,
      action: state.canSelectMore
        ? "Choose items or allow all"
        : "Change in Android Settings",
      actionKind: state.canSelectMore ? "request" : "settings",
    };
  return {
    label: "Not allowed",
    detail: `${sentence(appName)} cannot read your photo library. Captures you make in ${appName} and items you pick are still available.`,
    action: state.settingsRequired ? "Open Android Settings" : "Allow access",
    actionKind: state.settingsRequired ? "settings" : "request",
  };
}

/** A bounded in-memory catalog over paged reads. Thumbnails are kept only for the newest
 * rows; a scope downgrade or MediaStore version change clears everything rather than
 * showing items the app may no longer read. */
export class LibraryCatalog {
  items: LibraryItem[] = [];
  next = "";
  version = "";
  generation = 0;
  scope: LibraryScope = "unavailable";
  loaded = false;
  /** True when the catalog stopped at `LIBRARY_LIMITS.kept` while the library had more rows.
   * `next` is then empty so no further page loads, but the catalog is not complete. */
  capped = false;
  private readonly ids = new Set<string>();

  reset() {
    this.items = [];
    this.ids.clear();
    this.next = "";
    this.version = "";
    this.generation = 0;
    this.loaded = false;
    this.capped = false;
  }

  /** Returns true when the catalog had to be cleared. */
  observeScope(state: LibraryScopeState): boolean {
    const narrowed =
      this.scope !== state.scope &&
      this.scope !== "unavailable" &&
      (state.scope !== "full" || this.scope === "denied");
    const versionChanged =
      !!this.version && !!state.version && this.version !== state.version;
    this.scope = state.scope;
    if (
      state.scope === "denied" ||
      state.locked ||
      narrowed ||
      versionChanged
    ) {
      this.reset();
      return true;
    }
    return false;
  }

  /** Append one page. `first` replaces the catalog (fresh load or reset). */
  apply(page: LibraryPage, first: boolean) {
    this.observeScope(page.scope);
    if (first) this.reset();
    this.scope = page.scope.scope;
    this.version = page.scope.version;
    if (first || !this.generation) this.generation = page.generation;
    let dropped = false;
    for (const item of page.items) {
      if (this.ids.has(item.id)) continue;
      if (this.items.length >= LIBRARY_LIMITS.kept) {
        dropped = true;
        break;
      }
      this.ids.add(item.id);
      this.items.push(item);
    }
    if (this.items.length < LIBRARY_LIMITS.kept) this.next = page.next;
    else {
      // Stop paging at the cap, but say so: an empty cursor alone would read as "end of library".
      if (dropped || page.next !== "") this.capped = true;
      this.next = "";
    }
    this.loaded = true;
    this.trimThumbnails();
  }

  private trimThumbnails() {
    let kept = 0;
    for (const item of this.items)
      if (item.image) {
        kept++;
        if (kept > LIBRARY_LIMITS.thumbnailsKept) delete item.image;
      }
  }

  /** Apply revalidation: missing rows leave, changed rows take their fresh metadata
   * (keeping the old thumbnail only when the bytes are unchanged is impossible to know, so it is dropped). */
  reconcile(results: LibraryValidation[]): {
    removed: string[];
    changed: string[];
  } {
    const removed: string[] = [],
      changed: string[] = [];
    for (const result of results) {
      const index = this.items.findIndex((item) => item.id === result.id);
      if (index < 0) continue;
      if (result.status === "missing") {
        this.items.splice(index, 1);
        this.ids.delete(result.id);
        removed.push(result.id);
      } else if (result.status === "changed" && result.item) {
        this.items[index] = { ...result.item };
        changed.push(result.id);
      }
    }
    return { removed, changed };
  }

  /** Apply an incremental change read: trashed rows leave, known rows update, new rows wait for a reload. */
  applyChanges(
    rows: (LibraryItem & { trashed?: boolean })[],
    generation: number,
  ): { removed: string[]; changed: string[]; added: number } {
    const removed: string[] = [],
      changed: string[] = [];
    let added = 0;
    for (const row of rows) {
      const index = this.items.findIndex((item) => item.id === row.id);
      if (index < 0) {
        if (!row.trashed) added++;
        continue;
      }
      if (row.trashed) {
        this.items.splice(index, 1);
        this.ids.delete(row.id);
        removed.push(row.id);
      } else if (this.items[index].revision !== row.revision) {
        const { trashed: _ignored, ...fresh } = row;
        this.items[index] = fresh;
        changed.push(row.id);
      }
    }
    this.generation = Math.max(this.generation, generation);
    return { removed, changed, added };
  }

  /** The loaded identities to revalidate, newest first, bounded per native call. */
  validationBatch(offset = 0): { id: string; revision: string }[] {
    return this.items
      .slice(offset, offset + LIBRARY_LIMITS.validate)
      .map((item) => ({ id: item.id, revision: item.revision }));
  }
}

/** Owner selection inside the device library: at most 20 exact identities with revisions. */
export class LibrarySelection {
  private readonly chosen = new Map<string, string>();
  get size() {
    return this.chosen.size;
  }
  has(id: string) {
    return this.chosen.has(id);
  }
  toggle(item: Pick<LibraryItem, "id" | "revision">): boolean {
    if (this.chosen.delete(item.id)) return false;
    if (this.chosen.size >= LIBRARY_LIMITS.action)
      throw Error("Select at most 20 items");
    this.chosen.set(item.id, item.revision);
    return true;
  }
  clear() {
    this.chosen.clear();
  }
  items(): { id: string; revision: string }[] {
    return [...this.chosen].map(([id, revision]) => ({ id, revision }));
  }
  /** Drop identities the catalog no longer has, and refresh changed revisions so a later
   * review shows the current item rather than silently acting on a stale one. */
  reconcile(catalog: LibraryCatalog): { dropped: number; changed: number } {
    let dropped = 0,
      changed = 0;
    for (const [id, revision] of [...this.chosen]) {
      const item = catalog.items.find((row) => row.id === id);
      if (!item) {
        this.chosen.delete(id);
        dropped++;
      } else if (item.revision !== revision) {
        this.chosen.delete(id);
        changed++;
      }
    }
    return { dropped, changed };
  }
}

export type LibraryChange = "favorite" | "unfavorite" | "trash" | "delete";
export type LibraryAction = LibraryChange | "share";
/** Actions that remove media or send it out of the app. Each one is reviewed by the owner in
 * the app and then in Android's own confirmation or chooser. Restore is not offered: trashed rows
 * are never paged, so no UI or agent path can select one. */
export const REVIEWED_LIBRARY_ACTIONS: readonly LibraryAction[] = [
  "trash",
  "share",
  "favorite",
  "unfavorite",
];
export const DESTRUCTIVE_LIBRARY_ACTIONS: readonly LibraryAction[] = ["trash"];

export type LibraryReview = {
  id: string;
  action: LibraryAction;
  items: { id: string; revision: string }[];
  expiresAt: number;
  title: string;
  detail: string;
};
const REVIEW_TTL = 120_000;

export function reviewText(
  action: LibraryAction,
  count: number,
  appName: string = LIBRARY_APP_NAME,
): { title: string; detail: string } {
  const n = count === 1 ? "1 item" : `${count} items`;
  switch (action) {
    case "trash":
      return {
        title: `Move ${n} to trash?`,
        detail:
          "Android asks you to confirm. Items stay in Android trash until it empties them; other apps see them removed.",
      };
    case "delete":
      return {
        title: `Delete ${n} permanently?`,
        detail: `Android asks you to confirm. This removes the media from the device for every app and cannot be undone by ${appName}.`,
      };
    case "share":
      return {
        title: `Share ${n}?`,
        detail:
          "Android opens its share sheet with read-only access to exactly these items. Nothing is sent until you choose an app there.",
      };
    case "favorite":
      return {
        title: `Favorite ${n}?`,
        detail:
          "Android asks you to confirm marking these items as favorites for every gallery app.",
      };
    default:
      return {
        title: `Remove ${n} from favorites?`,
        detail: "Android asks you to confirm.",
      };
  }
}

/** Freeze exactly what the owner reviews. */
export function prepareReview(
  action: LibraryAction,
  items: { id: string; revision: string }[],
  now = Date.now(),
  random: () => string = () => crypto.randomUUID(),
): LibraryReview {
  if (!REVIEWED_LIBRARY_ACTIONS.includes(action))
    throw Error("Unsupported library action");
  if (!items.length || items.length > LIBRARY_LIMITS.action)
    throw Error("Select 1–20 items");
  const unique = new Set<string>();
  for (const item of items) {
    if (
      !isLibraryId(item.id) ||
      !validRevision(item.revision) ||
      unique.has(item.id)
    )
      throw Error("Invalid reviewed item");
    unique.add(item.id);
  }
  return {
    id: random(),
    action,
    items: items.map((item) => ({ id: item.id, revision: item.revision })),
    expiresAt: now + REVIEW_TTL,
    ...reviewText(action, items.length),
  };
}

export function reviewCurrent(
  review: LibraryReview | undefined,
  catalog: LibraryCatalog,
  now = Date.now(),
): boolean {
  if (!review || now >= review.expiresAt) return false;
  return review.items.every((reviewed) =>
    catalog.items.some(
      (item) => item.id === reviewed.id && item.revision === reviewed.revision,
    ),
  );
}

/** Session-local opaque revisions for model-facing identities. The native revision embeds the
 * file's modification time and byte size; it never leaves the phone. A model sees
 * `rev-<session>-<n>` and echoes it back; only this map resolves it to the native revision. */
export const MODEL_REVISION = /^rev-[a-z0-9]{1,16}-[1-9][0-9]{0,9}$/;
export class LibraryRevisions {
  private readonly toOpaque = new Map<
    string,
    { native: string; opaque: string }
  >();
  private counter = 0;
  private readonly session: string;
  private readonly kept: number;
  constructor(session: string, kept: number = LIBRARY_LIMITS.kept) {
    if (!/^[a-z0-9]{1,16}$/.test(session))
      throw Error("Invalid revision session");
    this.session = session;
    this.kept = kept;
  }
  /** The opaque revision for this exact native revision; a changed item gets a new one. */
  model(id: string, native: string): string {
    if (!isLibraryId(id) || !validRevision(native))
      throw Error("Invalid library revision");
    const previous = this.toOpaque.get(id);
    const opaque =
      previous?.native === native
        ? previous.opaque
        : `rev-${this.session}-${++this.counter}`;
    this.toOpaque.delete(id);
    this.toOpaque.set(id, { native, opaque });
    if (this.toOpaque.size > this.kept)
      this.toOpaque.delete(this.toOpaque.keys().next().value as string);
    return opaque;
  }
  /** The native revision behind an opaque one, or undefined when it is unknown or superseded. */
  native(id: string, opaque: string): string | undefined {
    const known = this.toOpaque.get(id);
    return known && known.opaque === opaque ? known.native : undefined;
  }
}

/** Operations the local agent may ask for. Search/inspect/select read locally; every change and
 * every share becomes a review the owner confirms in the app and then in Android, never a direct
 * effect. Search takes no text: file and album names are matched only by the owner, so hit/miss
 * results cannot be used to probe names the model is not given. */
export type LibraryAgentOperation =
  | {
      type: "photo_library_search";
      kind?: LibraryKind | "all";
      from?: number;
      to?: number;
      favorites?: boolean;
      limit?: number;
    }
  | { type: "photo_library_inspect"; id: string }
  | { type: "photo_library_select"; ids: string[] }
  | {
      type: "photo_library_review";
      action: LibraryAction;
      items: { id: string; revision: string }[];
    };
/** Negotiated with the agent before any library proposal is accepted. */
export const PHOTO_LIBRARY_CAPABILITY = "photos.library.v1";
export const LIBRARY_OPERATION_TYPES: readonly string[] = [
  "photo_library_search",
  "photo_library_inspect",
  "photo_library_select",
  "photo_library_review",
];
export function isLibraryOperation(
  value: unknown,
): value is LibraryAgentOperation {
  return (
    !!value &&
    typeof value === "object" &&
    LIBRARY_OPERATION_TYPES.includes(String((value as Bag).type))
  );
}

export function validateLibraryOperation(
  value: unknown,
): LibraryAgentOperation {
  const op = bag(value);
  const allowed = (keys: string[]) => {
    for (const key of Object.keys(op))
      if (!keys.includes(key))
        throw Error("Unexpected library operation field");
  };
  if (op.type === "photo_library_search") {
    allowed(["type", "kind", "from", "to", "favorites", "limit"]);
    if (
      op.kind !== undefined &&
      !["image", "video", "all"].includes(String(op.kind))
    )
      throw Error("Invalid library kind");
    for (const key of ["from", "to"] as const)
      if (
        op[key] !== undefined &&
        !(Number.isSafeInteger(op[key]) && (op[key] as number) >= 0)
      )
        throw Error("Invalid library date");
    if (
      op.from !== undefined &&
      op.to !== undefined &&
      (op.from as number) > (op.to as number)
    )
      throw Error("Invalid library date range");
    if (op.favorites !== undefined && typeof op.favorites !== "boolean")
      throw Error("Invalid favorites filter");
    if (
      op.limit !== undefined &&
      !(
        Number.isInteger(op.limit) &&
        (op.limit as number) >= 1 &&
        (op.limit as number) <= 50
      )
    )
      throw Error("Invalid library limit");
    return {
      type: op.type,
      ...(op.kind !== undefined
        ? { kind: op.kind as LibraryKind | "all" }
        : {}),
      ...(op.from !== undefined ? { from: op.from as number } : {}),
      ...(op.to !== undefined ? { to: op.to as number } : {}),
      ...(op.favorites !== undefined
        ? { favorites: op.favorites as boolean }
        : {}),
      ...(op.limit !== undefined ? { limit: op.limit as number } : {}),
    };
  }
  if (op.type === "photo_library_inspect") {
    allowed(["type", "id"]);
    if (!isLibraryId(op.id)) throw Error("Invalid library id");
    return { type: op.type, id: op.id };
  }
  if (op.type === "photo_library_select") {
    allowed(["type", "ids"]);
    if (
      !Array.isArray(op.ids) ||
      !op.ids.length ||
      op.ids.length > LIBRARY_LIMITS.action ||
      !op.ids.every(isLibraryId) ||
      new Set(op.ids).size !== op.ids.length
    )
      throw Error("Invalid library selection");
    return { type: op.type, ids: [...op.ids] as string[] };
  }
  if (op.type === "photo_library_review") {
    allowed(["type", "action", "items"]);
    if (!REVIEWED_LIBRARY_ACTIONS.includes(op.action as LibraryAction))
      throw Error("Unsupported library action");
    if (
      !Array.isArray(op.items) ||
      !op.items.length ||
      op.items.length > LIBRARY_LIMITS.action
    )
      throw Error("Select 1–20 items");
    const unique = new Set<string>(),
      items = op.items.map((entry) => {
        const item = bag(entry);
        if (Object.keys(item).some((key) => key !== "id" && key !== "revision"))
          throw Error("Unexpected reviewed item field");
        // The model only ever holds opaque revisions; a native revision here is refused.
        if (
          !isLibraryId(item.id) ||
          typeof item.revision !== "string" ||
          !MODEL_REVISION.test(item.revision) ||
          unique.has(item.id)
        )
          throw Error("Invalid reviewed item");
        unique.add(item.id);
        return { id: item.id, revision: item.revision };
      });
    return { type: op.type, action: op.action as LibraryAction, items };
  }
  throw Error("Unsupported library operation");
}

/** Owner-facing text for an agent library proposal. */
export function describeLibraryOperation(
  op: LibraryAgentOperation,
  appName: string = LIBRARY_APP_NAME,
): { title: string; description: string } {
  if (op.type === "photo_library_search") {
    const what =
      op.kind === "image"
        ? "photos"
        : op.kind === "video"
          ? "videos"
          : "photos and videos";
    return {
      title: "Search device library",
      description: `List up to ${op.limit ?? 20} ${op.favorites ? "favorite " : ""}${what} Android lets ${appName} read${op.from !== undefined || op.to !== undefined ? " in the requested date range" : ""}. The agent receives ids, kind, dates, dimensions and duration only: no file or album names, no location, no pixels.`,
    };
  }
  if (op.type === "photo_library_inspect")
    return {
      title: "Inspect one library item",
      description:
        "Share one item's id, kind, dates, dimensions and duration with the agent. No file or album name, location or pixels.",
    };
  if (op.type === "photo_library_select")
    return {
      title: `Select ${op.ids.length === 1 ? "1 item" : `${op.ids.length} items`} in Photos`,
      description:
        "Mark these items as selected in Photos > Device library on this phone. Nothing is changed or shared.",
    };
  const text = reviewText(op.action, op.items.length, appName);
  return {
    title: text.title,
    description: `Open this review in Photos > Device library. You confirm it there and then in Android's own dialog or share sheet before anything changes or leaves the phone. ${text.detail}`,
  };
}

/** What a model may receive about library items: identity, an opaque session revision, kind,
 * dates and shape. No file or album names, no size or modification time, no location, no pixels. */
export type LibraryModelItem = {
  id: string;
  revision: string;
  kind: LibraryKind;
  takenAt: number;
  width: number;
  height: number;
  duration?: number;
  favorite?: true;
};
export function modelItem(
  item: LibraryItem,
  revisions: LibraryRevisions,
): LibraryModelItem {
  return {
    id: item.id,
    revision: revisions.model(item.id, item.revision),
    kind: item.kind,
    takenAt: item.takenAt,
    width: item.width,
    height: item.height,
    ...(item.kind === "video" && item.duration
      ? { duration: Math.round(item.duration) }
      : {}),
    ...(item.favorite ? { favorite: true as const } : {}),
  };
}
export function modelSearchResult(
  page: LibraryPage,
  revisions: LibraryRevisions,
  limit = 50,
): { scope: LibraryScope; items: LibraryModelItem[]; more: boolean } {
  return {
    scope: page.scope.scope,
    items: page.items.slice(0, limit).map((item) => modelItem(item, revisions)),
    more: !!page.next || page.items.length > limit,
  };
}

/** The structured result an approved library operation returns to the agent. */
export type LibraryAgentResult =
  | {
      kind: "photo_library_search";
      scope: LibraryScope;
      items: LibraryModelItem[];
      more: boolean;
    }
  | { kind: "photo_library_inspect"; item: LibraryModelItem }
  | { kind: "photo_library_select"; selected: number; missing: number }
  | {
      kind: "photo_library_review";
      status: "review_opened";
      action: LibraryAction;
      count: number;
    };
const MODEL_KEYS = [
  "id",
  "revision",
  "kind",
  "takenAt",
  "width",
  "height",
  "duration",
  "favorite",
];
function validateModelItem(value: unknown): LibraryModelItem {
  const row = bag(value);
  if (Object.keys(row).some((key) => !MODEL_KEYS.includes(key)))
    throw Error("Unexpected library result field");
  if (
    !isLibraryId(row.id) ||
    typeof row.revision !== "string" ||
    !MODEL_REVISION.test(row.revision) ||
    row.kind !== libraryKindOf(row.id)
  )
    throw Error("Invalid library result item");
  for (const key of ["takenAt", "width", "height"] as const)
    if (
      !(
        typeof row[key] === "number" &&
        Number.isFinite(row[key]) &&
        (row[key] as number) >= 0
      )
    )
      throw Error("Invalid library result item");
  if (
    row.duration !== undefined &&
    !(Number.isInteger(row.duration) && (row.duration as number) >= 0)
  )
    throw Error("Invalid library result item");
  if (row.favorite !== undefined && row.favorite !== true)
    throw Error("Invalid library result item");
  return row as LibraryModelItem;
}
export function validateLibraryResult(
  op: LibraryAgentOperation,
  value: unknown,
): LibraryAgentResult {
  const row = bag(value);
  if (row.kind !== op.type) throw Error("Library result kind mismatch");
  const keys = (list: string[]) => {
    if (Object.keys(row).some((key) => !list.includes(key)))
      throw Error("Unexpected library result field");
  };
  if (op.type === "photo_library_search") {
    keys(["kind", "scope", "items", "more"]);
    if (
      !["full", "partial", "selected"].includes(String(row.scope)) ||
      !Array.isArray(row.items) ||
      row.items.length > (op.limit ?? 50) ||
      typeof row.more !== "boolean"
    )
      throw Error("Invalid library search result");
    return {
      kind: op.type,
      scope: row.scope as LibraryScope,
      items: row.items.map(validateModelItem),
      more: row.more,
    };
  }
  if (op.type === "photo_library_inspect") {
    keys(["kind", "item"]);
    const item = validateModelItem(row.item);
    if (item.id !== op.id) throw Error("Library result id mismatch");
    return { kind: op.type, item };
  }
  if (op.type === "photo_library_select") {
    keys(["kind", "selected", "missing"]);
    if (
      !Number.isInteger(row.selected) ||
      !Number.isInteger(row.missing) ||
      (row.selected as number) < 0 ||
      (row.missing as number) < 0 ||
      (row.selected as number) + (row.missing as number) !== op.ids.length
    )
      throw Error("Invalid library selection result");
    return {
      kind: op.type,
      selected: row.selected as number,
      missing: row.missing as number,
    };
  }
  keys(["kind", "status", "action", "count"]);
  if (
    row.status !== "review_opened" ||
    row.action !== op.action ||
    row.count !== op.items.length
  )
    throw Error("Invalid library review result");
  return {
    kind: op.type,
    status: "review_opened",
    action: op.action,
    count: op.items.length,
  };
}

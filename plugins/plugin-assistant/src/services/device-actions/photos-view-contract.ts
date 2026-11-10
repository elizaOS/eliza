/** Phone Photos view operations: filter the grid, open one item, create an album, share items.
 * Dependency-free apart from the photo library contract, so hosts and tests can use the rules
 * anywhere. Validation rejects rather than truncates. Owner-facing review text is the change
 * itself, nothing else; `describePhotosViewOperation` takes the host's product name like
 * `describeLibraryOperation`, though no Photos view text needs it.
 *
 * `photos_filter` only narrows what the Photos grid shows, behind a clearable chip, and returns
 * counts, never items. `photos_open` opens one item in the Photos viewer. Neither changes or
 * shares media, so both may run directly when the owner's own current message asked for them;
 * otherwise they are reviewed. `photos_album_create` is a data change and `photos_share` sends
 * media out of the phone, so the owner reviews each in Photos first; a share then opens
 * Android's share sheet, and nothing leaves the phone before the owner picks a target there.
 * All four require both `photos.library.v1` and `photos.view.v1`. */
import {
  isLibraryId,
  LIBRARY_APP_NAME,
  LIBRARY_LIMITS,
  type LibraryKind,
  libraryKindOf,
  PHOTO_LIBRARY_CAPABILITY,
} from "./photo-library-contract.ts";

export const PHOTOS_VIEW_CAPABILITY = "photos.view.v1";
/** Album keys photos_filter accepts besides a custom album id ("custom:<id>"). */
export const PHOTOS_FILTER_ALBUMS = [
  "favorites",
  "videos",
  "camera",
  "screenshots",
] as const;
export type PhotosFilterAlbum =
  | (typeof PHOTOS_FILTER_ALBUMS)[number]
  | `custom:${string}`;
export const PHOTOS_ALBUM_NAME_MAX = 80;
export const PHOTOS_SHARE_MAX = 100;
const CUSTOM_ALBUM = /^custom:[A-Za-z0-9_-]{1,80}$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: names and query text must reject control characters.
const CONTROL = /[\u0000-\u001f\u007f]/;

export type PhotosViewOperation =
  | {
      type: "photos_filter";
      from?: number;
      to?: number;
      kind?: LibraryKind;
      favorite?: boolean;
      album?: PhotosFilterAlbum;
      text?: string;
    }
  | { type: "photos_open"; id: string }
  | { type: "photos_album_create"; name: string; ids: string[] }
  | { type: "photos_share"; ids: string[] };
export type PhotosViewType = PhotosViewOperation["type"];

export const PHOTOS_VIEW_TYPES: readonly PhotosViewType[] = [
  "photos_filter",
  "photos_open",
  "photos_album_create",
  "photos_share",
];
/** May run without a review only when bound to the owner's own current message. */
export const PHOTOS_VIEW_DIRECT_TYPES: readonly PhotosViewType[] = [
  "photos_filter",
  "photos_open",
];

export function isPhotosViewType(type: unknown): type is PhotosViewType {
  return (PHOTOS_VIEW_TYPES as readonly unknown[]).includes(type);
}
export function isPhotosViewOperation(
  value: unknown,
): value is PhotosViewOperation {
  return (
    !!value &&
    typeof value === "object" &&
    isPhotosViewType((value as { type?: unknown }).type)
  );
}
/** Both the library and the view capability must have been negotiated. */
export function photosViewCapabilityAvailable(
  capabilities?: readonly string[],
): boolean {
  return (
    capabilities?.includes(PHOTO_LIBRARY_CAPABILITY) === true &&
    capabilities.includes(PHOTOS_VIEW_CAPABILITY)
  );
}

type Bag = Record<string, unknown>;
function bag(value: unknown, message: string): Bag {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error(message);
  return value as Bag;
}
function only(op: Bag, keys: readonly string[], message: string): void {
  for (const key of Object.keys(op))
    if (!keys.includes(key)) throw Error(message);
}
function libraryIds(value: unknown, max: number, message: string): string[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > max ||
    !value.every(isLibraryId) ||
    new Set(value).size !== value.length
  )
    throw Error(message);
  return [...value] as string[];
}

export function validatePhotosViewOperation(
  value: unknown,
): PhotosViewOperation {
  const op = bag(value, "Invalid Photos operation");
  const allowed = (keys: string[]) => only(op, keys, "Unexpected Photos field");
  if (op.type === "photos_filter") {
    allowed(["type", "from", "to", "kind", "favorite", "album", "text"]);
    for (const key of ["from", "to"] as const)
      if (
        op[key] !== undefined &&
        !(Number.isSafeInteger(op[key]) && (op[key] as number) >= 0)
      )
        throw Error("Invalid filter date");
    if (
      op.from !== undefined &&
      op.to !== undefined &&
      (op.from as number) > (op.to as number)
    )
      throw Error("Invalid filter date range");
    if (op.kind !== undefined && op.kind !== "image" && op.kind !== "video")
      throw Error("Invalid filter kind");
    if (op.favorite !== undefined && typeof op.favorite !== "boolean")
      throw Error("Invalid favorites filter");
    if (
      op.album !== undefined &&
      !(
        typeof op.album === "string" &&
        ((PHOTOS_FILTER_ALBUMS as readonly string[]).includes(op.album) ||
          CUSTOM_ALBUM.test(op.album))
      )
    )
      throw Error("Invalid filter album");
    if (
      op.text !== undefined &&
      !(
        typeof op.text === "string" &&
        op.text.length <= LIBRARY_LIMITS.query &&
        !CONTROL.test(op.text)
      )
    )
      throw Error("Invalid filter text");
    return {
      type: "photos_filter",
      ...(op.from !== undefined ? { from: op.from as number } : {}),
      ...(op.to !== undefined ? { to: op.to as number } : {}),
      ...(op.kind !== undefined ? { kind: op.kind as LibraryKind } : {}),
      ...(op.favorite !== undefined
        ? { favorite: op.favorite as boolean }
        : {}),
      ...(op.album !== undefined
        ? { album: op.album as PhotosFilterAlbum }
        : {}),
      ...(op.text !== undefined ? { text: op.text as string } : {}),
    };
  }
  if (op.type === "photos_open") {
    allowed(["type", "id"]);
    if (!isLibraryId(op.id)) throw Error("Invalid library id");
    return { type: "photos_open", id: op.id };
  }
  if (op.type === "photos_album_create") {
    allowed(["type", "name", "ids"]);
    if (
      typeof op.name !== "string" ||
      op.name.trim().length < 1 ||
      op.name.trim().length > PHOTOS_ALBUM_NAME_MAX ||
      CONTROL.test(op.name)
    )
      throw Error("Choose an album name between 1 and 80 characters");
    return {
      type: "photos_album_create",
      name: op.name.trim(),
      ids: libraryIds(op.ids, LIBRARY_LIMITS.kept, "Invalid album items"),
    };
  }
  if (op.type === "photos_share") {
    allowed(["type", "ids"]);
    return {
      type: "photos_share",
      ids: libraryIds(op.ids, PHOTOS_SHARE_MAX, "Invalid share items"),
    };
  }
  throw Error("Unsupported Photos operation");
}

const quoted = (value: string) => `“${value}”`;
const items = (count: number) => `${count} ${count === 1 ? "item" : "items"}`;
const ALBUM_LABELS: Record<(typeof PHOTOS_FILTER_ALBUMS)[number], string> = {
  favorites: "Favorites",
  videos: "Videos",
  camera: "Camera",
  screenshots: "Screenshots",
};
/** The review card: the change itself, nothing else. */
export function describePhotosViewOperation(
  op: PhotosViewOperation,
  _appName: string = LIBRARY_APP_NAME,
): { title: string; description: string } {
  if (op.type === "photos_filter")
    return {
      title: "Filter Photos",
      description:
        [
          op.kind === "image" ? "Photos" : op.kind === "video" ? "Videos" : "",
          op.favorite === true
            ? "Favorites"
            : op.favorite === false
              ? "Not favorites"
              : "",
          op.album
            ? op.album.startsWith("custom:")
              ? "In an album"
              : `In ${ALBUM_LABELS[op.album as keyof typeof ALBUM_LABELS]}`
            : "",
          op.text ? quoted(op.text) : "",
          op.from !== undefined || op.to !== undefined
            ? "In the requested dates"
            : "",
        ]
          .filter(Boolean)
          .join(" · ") || "Everything",
    };
  if (op.type === "photos_open")
    return {
      title: libraryKindOf(op.id) === "video" ? "Open video" : "Open photo",
      description: "",
    };
  if (op.type === "photos_album_create")
    return {
      title: `Create album ${quoted(op.name)}`,
      description: items(op.ids.length),
    };
  return {
    title: `Share ${items(op.ids.length)}`,
    description: "Android share sheet",
  };
}

/** Where a proposal may be reviewed or run: Photos, open on the unlocked phone. */
export function photosViewContextAllowed(context: {
  view: string;
  sensitive?: boolean;
}): boolean {
  return !context.sensitive && context.view === "photos";
}

/** The structured result the phone returns. Filter and open report only counts or a flag; an
 * album or share result proves only that the owner review opened in Photos. */
export type PhotosViewResult =
  | { kind: "photos_filter"; shown: number; more: boolean }
  | { kind: "photos_open"; opened: boolean }
  | {
      kind: "photos_album_create";
      status: "review_opened";
      count: number;
      missing: number;
    }
  | {
      kind: "photos_share";
      status: "review_opened";
      count: number;
      missing: number;
    };
const count = (value: unknown, min: number) =>
  Number.isInteger(value) && (value as number) >= min;
export function validatePhotosViewResult(
  op: PhotosViewOperation,
  value: unknown,
): PhotosViewResult {
  const row = bag(value, "Invalid Photos result");
  if (row.kind !== op.type) throw Error("Photos result kind mismatch");
  const keys = (list: string[]) =>
    only(row, list, "Unexpected Photos result field");
  if (op.type === "photos_filter") {
    keys(["kind", "shown", "more"]);
    if (!count(row.shown, 0) || typeof row.more !== "boolean")
      throw Error("Invalid photos filter result");
    return { kind: op.type, shown: row.shown as number, more: row.more };
  }
  if (op.type === "photos_open") {
    keys(["kind", "opened"]);
    if (typeof row.opened !== "boolean")
      throw Error("Invalid photos open result");
    return { kind: op.type, opened: row.opened };
  }
  keys(["kind", "status", "count", "missing"]);
  if (
    row.status !== "review_opened" ||
    !count(row.count, 1) ||
    !count(row.missing, 0) ||
    (row.count as number) + (row.missing as number) !== op.ids.length
  )
    throw Error(
      op.type === "photos_share"
        ? "Invalid share review result"
        : "Invalid album review result",
    );
  return {
    kind: op.type,
    status: "review_opened",
    count: row.count as number,
    missing: row.missing as number,
  };
}

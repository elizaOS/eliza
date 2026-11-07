type Note = Record<string, unknown>;
const content = (note: Note) =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(note)
        .filter(
          ([key]) =>
            !["createdAt", "modifiedAt", "when", "pinned"].includes(key),
        )
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
  );
/** Preserve unknown legacy creation dates; only real content changes acquire a modification time. */
export function stampNoteChanges(
  previous: Note[],
  next: Note[],
  now = Date.now(),
) {
  const old = new Map(previous.map((note) => [note.id, note]));
  return next.map((note) => {
    const before = old.get(note.id);
    if (!before)
      return {
        ...note,
        createdAt: Number.isFinite(note.createdAt) ? note.createdAt : now,
        modifiedAt: now,
      };
    return {
      ...note,
      createdAt: before.createdAt,
      modifiedAt: content(before) === content(note) ? before.modifiedAt : now,
    };
  });
}

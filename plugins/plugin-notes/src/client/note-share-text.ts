/**
 * Plain-text serialization of one selected note for copy, share, export and
 * email drafts. It uses only the note's stored authored content; a voice note's
 * audio is never implied or attached, and an absent transcript is stated as
 * absent rather than invented.
 */
export interface ShareableNote {
  kind: string;
  title?: string;
  body?: string;
  audio?: { transcript?: string };
  items?: { t: string; done?: boolean }[];
  url?: string;
  clips?: string[];
  lines?: { s?: string; t: string; at?: number }[];
  summary?: string[];
  actions?: { t: string; done?: boolean }[];
}
export interface NoteShareText {
  title: string;
  /** Title, a blank line, then the kind-specific body. */
  text: string;
}

const checklist = (rows: readonly { t: string; done?: boolean }[]) =>
  rows.map((item) => `[${item.done ? "x" : " "}] ${item.t}`).join("\n");

export function noteShareText(note: ShareableNote): NoteShareText {
  const title = String(note.title || "Note");
  let body: string;
  if (note.kind === "text") body = String(note.body || "");
  else if (note.kind === "list") body = checklist(note.items || []);
  else if (note.kind === "link")
    body = [note.url, ...(note.clips || [])].filter(Boolean).join("\n\n");
  else if (note.kind === "voice") {
    const transcript = String(note.body || note.audio?.transcript || "");
    const lines = transcript
      ? [transcript]
      : (note.lines || []).map((line) => line.t).filter(Boolean);
    body = [
      "Voice note text (audio not included)",
      lines.length ? `Transcript\n${lines.join("\n")}` : "No transcript saved.",
      note.summary?.length ? `Summary\n${note.summary.join("\n")}` : "",
      note.actions?.length ? `Action items\n${checklist(note.actions)}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  } else throw Error("This note has no supported text export.");
  return { title, text: [title, body].filter(Boolean).join("\n\n") };
}

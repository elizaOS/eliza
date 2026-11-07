/** Shared location of the optional browser frame; importing it never starts capture. */
import { tmpdir } from "node:os";
import { join } from "node:path";

export const FRAME_FILE = join(tmpdir(), "eliza-stream-frame.jpg");

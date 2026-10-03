import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

/** Hash disk images without allocating an image-sized buffer. */
export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

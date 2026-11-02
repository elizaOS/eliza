import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";

export const RELEASE =
  "Alpha/alpha_stallion_phone/stallion:17/CP2A.261005.001/42:user/release-keys";
export const PREVIOUS =
  "Alpha/alpha_stallion_phone/stallion:17/CP2A.261005.001/41:user/release-keys";
export const PAYLOAD = Buffer.concat([
  Buffer.from("CrAU"),
  Buffer.alloc(60, 7),
]);
/** payload.bin is the first stored entry: a 30-byte local header plus its 11-byte name. */
export const OFFSET = 41;

/** A stored zip in the ota_from_target_files layout with a fake payload, entries in order. */
export function otaPackage(
  dir,
  name,
  {
    post = RELEASE,
    pre = null,
    offset = OFFSET,
    fileSize = PAYLOAD.length,
    omit = null,
  } = {},
) {
  const metadata = [
    `ota-streaming-property-files=payload.bin:${offset}:${PAYLOAD.length},payload_properties.txt:200:150,metadata:400:300          `,
    "ota-type=AB",
    `post-build=${post}`,
    "post-security-patch-level=2026-10-05",
    "post-timestamp=1793000000",
    ...(pre ? [`pre-build=${pre}`] : []),
    "pre-device=stallion",
  ].join("\n");
  const properties = `FILE_HASH=${createHash("sha256").update(PAYLOAD).digest("base64")}\nFILE_SIZE=${fileSize}\nMETADATA_HASH=bWV0YQ==\nMETADATA_SIZE=12\n`;
  const content = {
    "payload.bin": PAYLOAD.toString("latin1"),
    "payload_properties.txt": properties,
    "META-INF/com/android/metadata": metadata,
  };
  delete content[omit];
  const file = path.join(dir, name);
  execFileSync("python3", [
    "-I",
    "-c",
    "import json,sys,zipfile\nwith zipfile.ZipFile(sys.argv[1],'w') as z:\n for k,v in json.loads(sys.argv[2]).items(): z.writestr(k, v.encode('latin1'))",
    file,
    JSON.stringify(content),
  ]);
  return file;
}

/** Server-only diagnostic parser: values only, never raw header descriptions. */
export function speechHttpTimings(headers: Headers): Record<string, number> {
  const allow = new Set([
    "entry_dispatch",
    "inference_module_init",
    "cloud_worker",
    "speech_infrastructure",
    "speech_body",
    "speech_identity_rate",
    "speech_standing",
    "speech_consent_write",
    "speech_credential_validation",
    "speech_consent_consume",
    "speech_key_import",
    "speech_signing",
    "speech_post_sign_validation",
    "speech_directory_write",
  ]);
  let raw: string | null;
  try {
    raw = headers.get("server-timing");
  } catch {
    return {};
  }
  if (!raw || raw.length > 4096) return {};
  const result: Record<string, number> = {};
  const duplicate = new Set<string>();
  for (const part of raw.split(",").slice(0, 32)) {
    const match =
      /^\s*([a-z_]+)\s*;\s*dur=([0-9]+(?:\.[0-9]+)?)(?:\s*;[^,]*)?\s*$/.exec(
        part,
      );
    if (!match || !allow.has(match[1])) continue;
    const name = match[1],
      n = Number(match[2]);
    if (!Number.isFinite(n) || n < 0 || n > 60000) continue;
    if (Object.hasOwn(result, name)) {
      delete result[name];
      duplicate.add(name);
    } else if (!duplicate.has(name)) result[name] = n;
  }
  return result;
}

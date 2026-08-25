const KNOWN_ANDROID_ABIS = new Set([
  "arm64-v8a",
  "armeabi-v7a",
  "riscv64",
  "x86",
  "x86_64",
]);

export function parseAndroidSystemAbiAllowlist(raw) {
  if (raw == null || raw.trim() === "") return null;

  const abis = [...new Set(raw.split(/[\s,]+/).filter(Boolean))];
  if (abis.length === 0) {
    throw new Error("ELIZA_ANDROID_SYSTEM_ABIS must name at least one ABI");
  }
  const unsupported = abis.filter((abi) => !KNOWN_ANDROID_ABIS.has(abi));
  if (unsupported.length > 0) {
    throw new Error(
      `ELIZA_ANDROID_SYSTEM_ABIS contains unsupported ABI(s): ${unsupported.join(", ")}`,
    );
  }
  return abis;
}

export function androidSystemAbiForEntry(entry) {
  const normalized = entry.replaceAll("\\", "/");
  const match = /^(?:lib|assets\/agent)\/([^/]+)\//.exec(normalized);
  if (!match || !KNOWN_ANDROID_ABIS.has(match[1])) return null;
  return match[1];
}

export function androidSystemAbiEntriesToRemove(entries, allowedAbis) {
  const allowed = new Set(allowedAbis);
  return entries.filter((entry) => {
    const abi = androidSystemAbiForEntry(entry);
    return abi !== null && !allowed.has(abi);
  });
}

export function assertAndroidSystemAbiContents(entries, allowedAbis) {
  const allowed = new Set(allowedAbis);
  const packagedAbis = new Set(
    entries.map(androidSystemAbiForEntry).filter((abi) => abi !== null),
  );
  const unexpected = [...packagedAbis].filter((abi) => !allowed.has(abi));
  if (unexpected.length > 0) {
    throw new Error(
      `filtered Android system APK still contains ABI(s): ${unexpected.join(", ")}`,
    );
  }
  const missing = [...allowed].filter((abi) => !packagedAbis.has(abi));
  if (missing.length > 0) {
    throw new Error(
      `filtered Android system APK is missing requested ABI(s): ${missing.join(", ")}`,
    );
  }
}

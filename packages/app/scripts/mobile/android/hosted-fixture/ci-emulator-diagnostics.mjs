// Read-only evidence on the already admitted disposable hosted fixture.
export function captureFixtureDisplayEvidence(run, { now = Date.now } = {}) {
  const startedAt = now();
  const deadline = startedAt + 15_000;
  const reads = {
    power: ["shell", "dumpsys", "power"],
    windowPolicy: ["shell", "dumpsys", "window", "policy"],
  };
  const properties = [
    "ro.build.fingerprint",
    "ro.system.build.fingerprint",
    "ro.build.version.sdk",
    "ro.build.version.incremental",
    "ro.build.type",
    "ro.kernel.qemu",
    "ro.product.name",
    "ro.product.device",
    "sys.boot_completed",
  ];
  for (const property of properties)
    reads[property] = ["shell", "getprop", property];

  const evidence = { capturedAt: new Date(startedAt).toISOString(), reads: {} };
  for (const [name, args] of Object.entries(reads)) {
    const remaining = deadline - now();
    if (remaining <= 0) {
      evidence.reads[name] = { unavailable: true, budgetExhausted: true };
      continue;
    }
    const limit = name === "power" || name === "windowPolicy" ? 65_536 : 1_024;
    try {
      const raw = run(args, Math.min(2_000, remaining));
      evidence.reads[name] = {
        output: raw.slice(0, limit),
        truncated: raw.length > limit,
      };
    } catch {
      evidence.reads[name] = { unavailable: true };
    }
  }
  return evidence;
}

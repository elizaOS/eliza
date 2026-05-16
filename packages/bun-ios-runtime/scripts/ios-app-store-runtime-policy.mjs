export const appStoreExecutionProfile = "ios-app-store-nojit";

export const appStoreRuntimeEnv = {
  ELIZA_IOS_APP_STORE_LOCAL_EXECUTION: "1",
  ELIZA_IOS_NO_JIT: "1",
  ELIZA_IOS_DISABLE_DYNAMIC_LOADING: "1",
  ELIZA_IOS_DISABLE_PROCESS_SPAWN: "1",
  ELIZA_IOS_DISABLE_BUN_FFI: "1",
  ELIZA_IOS_DISABLE_BUN_SHELL: "1",
  ELIZA_IOS_DISABLE_BUN_SUBPROCESS: "1",
  JSC_useJIT: "0",
  JSC_jitPolicyScale: "0",
  BUN_JSC_useJIT: "0",
};

export const appStoreRuntimeCmakeArgs = [
  "-DELIZA_IOS_APP_STORE_LOCAL_EXECUTION=ON",
  "-DELIZA_IOS_NO_JIT=ON",
  "-DELIZA_IOS_DISABLE_DYNAMIC_LOADING=ON",
  "-DELIZA_IOS_DISABLE_PROCESS_SPAWN=ON",
  "-DELIZA_IOS_DISABLE_BUN_FFI=ON",
  "-DELIZA_IOS_DISABLE_BUN_SHELL=ON",
  "-DELIZA_IOS_DISABLE_BUN_SUBPROCESS=ON",
  "-DENABLE_JIT=OFF",
  "-DENABLE_DFG_JIT=OFF",
  "-DENABLE_FTL_JIT=OFF",
  "-DENABLE_WEBASSEMBLY_BBQJIT=OFF",
  "-DENABLE_REMOTE_INSPECTOR=OFF",
  "-DENABLE_SAMPLING_PROFILER=OFF",
  "-DENABLE_BUN_FFI=OFF",
  "-DENABLE_BUN_SHELL=OFF",
  "-DENABLE_BUN_SUBPROCESS=OFF",
];

export const appStoreRuntimeCompilerDefines = [
  "-DELIZA_IOS_APP_STORE_LOCAL_EXECUTION=1",
  "-DELIZA_IOS_NO_JIT=1",
  "-DELIZA_IOS_DISABLE_DYNAMIC_LOADING=1",
  "-DELIZA_IOS_DISABLE_PROCESS_SPAWN=1",
  "-DELIZA_IOS_DISABLE_BUN_FFI=1",
  "-DELIZA_IOS_DISABLE_BUN_SHELL=1",
  "-DELIZA_IOS_DISABLE_BUN_SUBPROCESS=1",
];

const forbiddenRuntimeImportGroups = [
  {
    label: "dynamic loader / native extension loading",
    patterns: [/^_dlopen$/, /^_dlsym$/],
    remediation:
      "compile out Bun.ffi, native plugin loading, and arbitrary dylib resolution for iOS App Store slices",
  },
  {
    label: "process spawning / helper executables",
    patterns: [
      /^_fork$/,
      /^_execve$/,
      /^_posix_spawn(?:$|_)/,
      /^_posix_spawnp$/,
      /^_pthread_atfork$/,
      /^_system$/,
    ],
    remediation:
      "compile out Bun.spawn, node:child_process, shell helpers, package postinstall runners, and subprocess fallbacks",
  },
  {
    label: "writable executable memory / JIT permissions",
    patterns: [
      /^_pthread_jit_write_protect_np$/,
      /^_mach_vm_protect$/,
      /^_vm_protect$/,
      /^_mprotect$/,
    ],
    remediation:
      "compile JSC/Bun with no JIT, no MAP_JIT, and no executable-memory permission toggles",
  },
];

const forbiddenRuntimeStringPatterns = [
  /\bMAP_JIT\b/i,
  /\ballow-jit\b/i,
  /\bdynamic-codesigning\b/i,
  /\bunsigned-executable-memory\b/i,
];

const forbiddenRuntimeImports = [
  ...new Set(
    forbiddenRuntimeImportGroups.flatMap((group) =>
      group.patterns
        .map((pattern) => pattern.source.match(/^\^(_[A-Za-z0-9_]+)\$$/)?.[1])
        .filter(Boolean),
    ),
  ),
];

export function findForbiddenRuntimeImportGroups(importOutput) {
  const symbols = new Set(
    String(importOutput)
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/).at(-1))
      .filter((symbol) => symbol?.startsWith("_")),
  );

  return forbiddenRuntimeImportGroups
    .map((group) => ({
      ...group,
      symbols: [...symbols]
        .filter((symbol) =>
          group.patterns.some((pattern) => pattern.test(symbol)),
        )
        .sort(),
    }))
    .filter((group) => group.symbols.length > 0);
}

export function findForbiddenRuntimeStrings(stringOutput) {
  return forbiddenRuntimeStringPatterns
    .filter((pattern) => pattern.test(String(stringOutput)))
    .map((pattern) => pattern.source);
}

export function appStoreRuntimeBuildSettingsText() {
  const envLines = Object.entries(appStoreRuntimeEnv).map(
    ([key, value]) => `  ${key}=${value}`,
  );
  return [
    "Required iOS App Store runtime build settings:",
    ...envLines,
    "Required CMake/fork flags:",
    ...appStoreRuntimeCmakeArgs.map((arg) => `  ${arg}`),
    "Required compiler defines for the engine/shim:",
    ...appStoreRuntimeCompilerDefines.map((arg) => `  ${arg}`),
  ].join("\n");
}

export function formatForbiddenRuntimeFindings({
  binary,
  importGroups = [],
  stringPatterns = [],
}) {
  const lines = [
    `${binary} is not App Store/device-safe for the full Bun engine runtime.`,
  ];

  if (importGroups.length > 0) {
    lines.push("Forbidden imported symbol groups:");
    for (const group of importGroups) {
      lines.push(`  - ${group.label}: ${group.symbols.join(", ")}`);
      lines.push(`    fix: ${group.remediation}`);
    }
  }

  if (stringPatterns.length > 0) {
    lines.push(
      `Forbidden executable-memory string markers: ${stringPatterns.join(", ")}`,
    );
  }

  lines.push(appStoreRuntimeBuildSettingsText());
  lines.push(
    "The device slice must be rebuilt from the Bun fork with these code paths compiled out; hiding symbols at link time is not sufficient because undefined imports remain in the Mach-O load commands.",
  );
  return lines.join("\n");
}

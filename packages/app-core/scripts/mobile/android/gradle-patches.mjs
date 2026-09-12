/** Transforms generated Android Gradle configuration for runtime packaging and target policy. */

import fs from "node:fs";
import process from "node:process";
import { escapeJavaString, escapeRegExp } from "../escape.mjs";

export function replaceOrInsertGradleString(content, key, value) {
  // AGP-modern uses `key = "value"`, AGP-legacy uses `key "value"`. Match
  // either and preserve the existing assignment shape so we don't flip
  // styles unnecessarily. The namespace declaration ships in the modern
  // form on Android Gradle Plugin 8+ generated projects, while
  // applicationId is still emitted in the legacy form by Capacitor's
  // template — both must be patchable.
  const re = new RegExp(`(${key}\\s*=?\\s*)["'][^"']+["']`);
  if (re.test(content)) {
    return content.replace(re, `$1"${value}"`);
  }
  return content;
}

export function appendMissingGradleDependency(content, notation) {
  if (content.includes(notation)) return content;
  return content.replace(
    /dependencies\s*\{/,
    `dependencies {\n    implementation "${notation}"`,
  );
}

/**
 * Inject `buildFeatures { buildConfig true }` and the `AOSP_BUILD`
 * buildConfigField into the app-level build.gradle.
 *
 * Why: `ElizaAgentService` reads `BuildConfig.AOSP_BUILD` to decide whether
 * to export `ELIZA_LOCAL_LLAMA=1` to the spawned bun process (see
 * eliza/packages/agent/src/runtime/aosp-llama-adapter.ts). AGP 8+ defaults
 * `buildFeatures.buildConfig` to false, so without the flag flip the
 * BuildConfig.java is never generated and the Java service refuses to
 * compile. The boolean field defaults to false, so the Capacitor APK build
 * keeps DeviceBridge inference; the AOSP build flow flips it to true via
 * the `-PelizaAospBuild=true` gradle property documented in
 * scripts/elizaos/build-aosp.mjs and SETUP_AOSP.md.
 */
export function injectBuildConfigAospField(content) {
  let next = content;
  if (!/\bbuildFeatures\s*\{/.test(next)) {
    next = next.replace(
      /android\s*\{/,
      `android {\n    buildFeatures {\n        buildConfig true\n    }\n`,
    );
  } else if (!/buildConfig\s+true/.test(next)) {
    next = next.replace(
      /buildFeatures\s*\{/,
      "buildFeatures {\n        buildConfig true",
    );
  }
  if (!/buildConfigField\s+["']boolean["'],\s*["']AOSP_BUILD["']/.test(next)) {
    next = next.replace(
      /defaultConfig\s*\{/,
      `defaultConfig {\n        buildConfigField "boolean", "AOSP_BUILD", "\${project.findProperty('elizaAospBuild') ?: 'false'}"\n`,
    );
  }
  return next;
}

export function androidSmsGatewayBuildConfigFieldLines() {
  return [
    `        buildConfigField "boolean", "ELIZA_ANDROID_LP3_COLOR_POLICY_ENABLED", "\${['1', 'true', 'yes'].contains((System.getenv('ELIZA_ANDROID_LP3_COLOR_POLICY_ENABLED') ?: 'false').toLowerCase())}"`,
    `        buildConfigField "boolean", "ELIZA_ANDROID_SMS_GATEWAY_ENABLED", "\${['1', 'true', 'yes'].contains((System.getenv('ELIZA_ANDROID_SMS_GATEWAY_ENABLED') ?: 'false').toLowerCase())}"`,
    `        buildConfigField "String", "ELIZA_ANDROID_SMS_GATEWAY_SECRET", "\\"${escapeJavaString(process.env.ELIZA_ANDROID_SMS_GATEWAY_SECRET ?? "")}\\""`,
    `        buildConfigField "String", "ELIZA_ANDROID_SMS_GATEWAY_WEBHOOK_URL", "\\"${escapeJavaString(process.env.ELIZA_ANDROID_SMS_GATEWAY_WEBHOOK_URL ?? "https://api.eliza.app/api/webhooks/blooio/local?bridge=bluebubbles")}\\""`,
    `        buildConfigField "String", "ELIZA_ANDROID_SMS_GATEWAY_PHONE_NUMBER", "\\"${escapeJavaString(process.env.ELIZA_ANDROID_SMS_GATEWAY_PHONE_NUMBER ?? "+14159611510")}\\""`,
    `        buildConfigField "String", "ELIZA_ANDROID_SMS_GATEWAY_PHONE_LABEL", "\\"${escapeJavaString(process.env.ELIZA_ANDROID_SMS_GATEWAY_PHONE_LABEL ?? "Eliza Cloud Gateway (+14159611510)")}\\""`,
  ];
}

export function injectAndroidSmsGatewayBuildConfigFields(content) {
  let next = injectBuildConfigAospField(content);
  const fields = androidSmsGatewayBuildConfigFieldLines();
  for (const field of fields) {
    const name = field.match(/,\s*"([^"]+)"/)?.[1];
    if (!name) continue;
    const existingRe = new RegExp(
      `\\n\\s*buildConfigField\\s+["'][^"']+["'],\\s*["']${escapeRegExp(name)}["'][^\\n]*`,
      "g",
    );
    next = next.replace(existingRe, "");
  }
  return next.replace(
    /defaultConfig\s*\{/,
    `defaultConfig {\n${fields.join("\n")}`,
  );
}

/**
 * Inject the `androidResources { noCompress += [...] }` block that keeps
 * `.tar.gz`, `.tar`, `.gguf`, and `.so` files byte-identical in the
 * packaged APK.
 *
 * Why: aapt2's default packaging treats `.gz` and `.tar.gz` as
 * "compressed-extension-to-preserve-uncompressed" and rewrites the entry
 * to a plain `.tar`. PGlite's runtime extension loader resolves
 * `vector.tar.gz` and `fuzzystrmatch.tar.gz` via
 * `new URL("../X", import.meta.url)`; when aapt2 strips the `.gz` the
 * loader can't find the file and the runtime falls over at first
 * Postgres extension call.
 *
 * Idempotent: re-runs are no-ops once the block is present. The matcher
 * accepts AGP-modern `androidResources` and legacy `aaptOptions` blocks,
 * but only injects when neither already lists `tar.gz`.
 */
export function injectNoCompressTarGz(content) {
  if (/noCompress[^\n]*['"]tar\.gz['"]/.test(content)) return content;
  const block =
    `\n    // Preserve .tar.gz / .tar / .gguf / .so as-is in the packaged APK.\n` +
    `    // aapt2 otherwise rewrites .tar.gz to .tar and PGlite's runtime\n` +
    `    // extension loader fails to find vector.tar.gz / fuzzystrmatch.tar.gz.\n` +
    `    androidResources {\n` +
    `        noCompress += ['gguf', 'tar.gz', 'so', 'tar']\n` +
    `    }\n`;
  // Inject just before the closing brace of the top-level `android { ... }`
  // block. Match the LAST `}` in the file as a heuristic that's robust
  // against arbitrary middle content.
  const androidOpen = content.search(/\n\s*android\s*\{/);
  if (androidOpen < 0) return content;
  // Find the matching closing brace by counting from the open.
  let depth = 0;
  let i = content.indexOf("{", androidOpen);
  while (i < content.length) {
    const ch = content[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return content.slice(0, i) + block + content.slice(i);
      }
    }
    i += 1;
  }
  return content;
}

/**
 * Keep packaged Android native libraries extracted on install.
 *
 * Normal Capacitor installs run as `untrusted_app`, which cannot execute
 * bun/musl files copied into app data. ElizaAgentService therefore prefers
 * the same payload shipped as libeliza_* native libraries; those files must
 * exist on disk under nativeLibraryDir for ProcessBuilder to execute them.
 */
export function injectNativeLibLegacyPackaging(content) {
  const assignment =
    "useLegacyPackaging = project.findProperty('elizaAospBuild') != 'true'";
  if (/useLegacyPackaging\s*=/.test(content)) {
    return content.replace(/useLegacyPackaging\s*=[^\n]*/, assignment);
  }
  if (/jniLibs\s*\{/.test(content)) {
    return content.replace(
      /jniLibs\s*\{/,
      "jniLibs {\n            useLegacyPackaging = project.findProperty('elizaAospBuild') != 'true'",
    );
  }
  if (/packaging\s*\{/.test(content)) {
    return content.replace(
      /packaging\s*\{/,
      "packaging {\n        jniLibs {\n            useLegacyPackaging = project.findProperty('elizaAospBuild') != 'true'\n        }",
    );
  }

  const block =
    `\n    packaging {\n` +
    `        jniLibs {\n` +
    `            useLegacyPackaging = project.findProperty('elizaAospBuild') != 'true'\n` +
    `        }\n` +
    `    }\n`;
  const androidOpen = content.search(/\n\s*android\s*\{/);
  if (androidOpen < 0) return content;
  let depth = 0;
  let i = content.indexOf("{", androidOpen);
  while (i < content.length) {
    const ch = content[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return content.slice(0, i) + block + content.slice(i);
      }
    }
    i += 1;
  }
  return content;
}

/**
 * Inject an optional app-thinning hook for `assets/agent/`.
 *
 * Local mode on stock Capacitor APKs now depends on the staged bun runtime,
 * agent-bundle, and PGlite payload, so the default mobile build must keep
 * assets/agent/*. CI/release jobs that deliberately want a cloud-only slim APK
 * can opt into stripping with `-PelizaStripAgentAssets=true`.
 *
 * Idempotent: re-runs are no-ops once the block is present.
 */
/**
 * Inject the `copyForkLlamaLib` Gradle task that bundles the buun-llama-cpp
 * fork's android-arm64 .so into the APK's jniLibs/. The fork's specialized
 * KV cache types (turbo3, turbo4, turbo3_tcq) and MTP spec-decoding kernels
 * live in this .so; without it, mobile only gets stock llama.cpp.
 *
 * Resolution order for the libdir:
 *   1. -Peliza.mtp.android.libdir=<path>   (gradle property)
 *   2. ELIZA_MTP_ANDROID_LIBDIR env var
 *   3. ~/.eliza/local-inference/bin/mtp/android-arm64-{cpu,vulkan}/
 *
 * Fails local builds when no path is configured or the dir doesn't exist. The
 * Android Capacitor JNI wrapper links against these MTP libraries and cannot
 * honestly support Eliza-1/Gemma 4 without them. Cloud builds skip the task.
 * A build with no fresh source dir falls back to the already-staged fused lib
 * set (the common dev case); only a genuinely missing arm64 lib is a hard error.
 *
 * Idempotent: re-runs are no-ops once the block is present.
 */
export function ensureCopyForkLlamaLibGuards(content) {
  if (!/\[copyForkLlamaLib\]/.test(content)) return content;
  if (/ELIZA_ANDROID_SKIP_FORK_LLAMA_LIB/.test(content)) return content;
  const guards =
    `        if (project.findProperty('elizaCloudBuild') == 'true' || System.getenv('ELIZA_ANDROID_SKIP_FORK_LLAMA_LIB') == '1') {\n` +
    `            println "[copyForkLlamaLib] skipped for cloud/smoke build"\n` +
    `            return\n` +
    `        }\n`;
  const oldCloudOnlyGuard =
    `        if (project.findProperty('elizaCloudBuild') == 'true') {\n` +
    `            println "[copyForkLlamaLib] skipped for cloud build"\n` +
    `            return\n` +
    `        }\n`;
  if (content.includes(oldCloudOnlyGuard)) {
    return content.replace(oldCloudOnlyGuard, guards);
  }
  return content.replace(
    /(task copyForkLlamaLib\s*\{\s*\n\s*doLast\s*\{\s*\n)/,
    `$1${guards}`,
  );
}

export function injectCopyForkLlamaLibTask(content) {
  if (/\[copyForkLlamaLib\]/.test(content)) {
    return ensureCopyForkLlamaLibGuards(content);
  }
  const block =
    `\n// Bundle the MTP Android llama.cpp stack into the APK so mobile\n` +
    `// gets Eliza-1/Gemma 4 support across every supported Android ABI\n` +
    `// (arm64-v8a, x86_64, riscv64). The arm64-v8a slice is mandatory for\n` +
    `// local-agent capable builds; x86_64 and riscv64 ship when their\n` +
    `// per-ABI artifacts exist (Wave 2 cross-compiles land them\n` +
    `// incrementally). Cloud builds and explicitly opted-out CI smoke\n` +
    `// builds skip this task.\n` +
    `ext.elizaForkLlamaAbis = ['arm64-v8a', 'x86_64', 'riscv64']\n` +
    `\n` +
    `ext.forkLlamaAbiTokens = [\n` +
    `    'arm64-v8a': 'android-arm64',\n` +
    `    'x86_64': 'android-x86_64',\n` +
    `    'riscv64': 'android-riscv64'\n` +
    `]\n` +
    `\n` +
    `ext.forkLlamaLibompAbiTokens = [\n` +
    `    'arm64-v8a': 'aarch64',\n` +
    `    'x86_64': 'x86_64',\n` +
    `    'riscv64': 'riscv64'\n` +
    `]\n` +
    `\n` +
    `def resolveForkLlamaLibDir = { String abi ->\n` +
    `    // arm64-v8a keeps the legacy un-suffixed property/env names for\n` +
    `    // backwards compatibility; other ABIs use the suffixed forms.\n` +
    `    def propSuffix = abi == 'arm64-v8a' ? '' : ".\${abi}"\n` +
    `    def envSuffix = abi == 'arm64-v8a' ? '' : "_\${abi.replace('-', '_').toUpperCase()}"\n` +
    `    def fromProp = project.findProperty("eliza.mtp.android.libdir\${propSuffix}")\n` +
    `    if (fromProp) return fromProp.toString()\n` +
    `    def fromEnv = System.getenv("ELIZA_MTP_ANDROID_LIBDIR\${envSuffix}")\n` +
    `    if (fromEnv) return fromEnv\n` +
    `    def stateDir = System.getenv('ELIZA_STATE_DIR') ?: "\${System.getProperty('user.home')}/.eliza"\n` +
    `    def abiToken = project.ext.forkLlamaAbiTokens[abi]\n` +
    `    def candidates = [\n` +
    `        new File(elizaRepoRoot, "packages/app/android/app/src/main/assets/agent/\${abi}").toString()\n` +
    `    ] + ['vulkan', 'cpu'].collect { backend ->\n` +
    `        "\${stateDir}/local-inference/bin/mtp/\${abiToken}-\${backend}"\n` +
    `    }\n` +
    `    return candidates.find { new File(it).isDirectory() }\n` +
    `}\n` +
    `\n` +
    `def resolveAndroidLibompForAbi = { String abi ->\n` +
    `    def localProperties = new Properties()\n` +
    `    def localPropertiesFile = rootProject.file('local.properties')\n` +
    `    if (localPropertiesFile.isFile()) {\n` +
    `        localPropertiesFile.withInputStream { localProperties.load(it) }\n` +
    `    }\n` +
    `    def sdkPath = localProperties.getProperty('sdk.dir') ?:\n` +
    `        System.getenv('ANDROID_HOME') ?:\n` +
    `        System.getenv('ANDROID_SDK_ROOT') ?:\n` +
    `        "\${System.getProperty('user.home')}/Library/Android/sdk"\n` +
    `    def androidSdk = new File(sdkPath)\n` +
    `    def ndkRoots = []\n` +
    `    def declaredNdkVersion = android.ndkVersion?.toString()\n` +
    `    if (declaredNdkVersion) ndkRoots << new File(androidSdk, "ndk/\${declaredNdkVersion}")\n` +
    `    ndkRoots << new File(androidSdk, 'ndk/29.0.13113456')\n` +
    `    def ndkParent = new File(androidSdk, 'ndk')\n` +
    `    if (ndkParent.isDirectory()) {\n` +
    `        (ndkParent.listFiles() ?: [] as File[]).each { ndkRoots << it }\n` +
    `    }\n` +
    `    def libompAbiToken = project.ext.forkLlamaLibompAbiTokens[abi]\n` +
    `    for (def ndkDir : ndkRoots.unique { it.absolutePath }) {\n` +
    `        def prebuiltDir = new File(ndkDir, 'toolchains/llvm/prebuilt')\n` +
    `        if (!prebuiltDir.isDirectory()) continue\n` +
    `        def hosts = prebuiltDir.listFiles() ?: [] as File[]\n` +
    `        for (def hostDir : hosts) {\n` +
    `            def clangDir = new File(hostDir, 'lib/clang')\n` +
    `            def versions = clangDir.listFiles() ?: [] as File[]\n` +
    `            for (def versionDir : versions) {\n` +
    `                def libomp = new File(versionDir, "lib/linux/\${libompAbiToken}/libomp.so")\n` +
    `                if (libomp.isFile()) return libomp\n` +
    `            }\n` +
    `        }\n` +
    `    }\n` +
    `    return null\n` +
    `}\n` +
    `\n` +
    `// NOTE: despite the legacy "ForkLlama" name, this stages the SINGLE canonical\n` +
    `// fused inference lib — libelizainference.so — with its own DT_NEEDED runtime\n` +
    `// siblings (libggml*, libllama.so, libllama-common.so, libmtmd.so, libomp.so),\n` +
    `// which ARE libelizainference's GPU/CPU backends, NOT a separate llama.cpp fork.\n` +
    `// There is no second inference library; do NOT delete this task or its siblings.\n` +
    `task copyForkLlamaLib {\n` +
    `    doLast {\n` +
    `        if (project.findProperty('elizaCloudBuild') == 'true' || System.getenv('ELIZA_ANDROID_SKIP_FORK_LLAMA_LIB') == '1') {\n` +
    `            println "[copyForkLlamaLib] skipped for cloud/smoke build"\n` +
    `            return\n` +
    `        }\n` +
    `        boolean stagedArm64 = false\n` +
    `        int totalCopied = 0\n` +
    `        boolean stagedKernels = false\n` +
    `        project.ext.elizaForkLlamaAbis.each { abi ->\n` +
    `            def libDir = resolveForkLlamaLibDir(abi)\n` +
    `            if (!libDir) {\n` +
    `                // No fresh source configured. If the fused lib set is already\n` +
    `                // staged in jniLibs (a prior build, the common dev case), use it\n` +
    `                // as-is so a plain build:android "just works" without any flag.\n` +
    `                def alreadyStaged = new File(file("src/main/jniLibs/\${abi}"), 'libelizainference.so')\n` +
    `                if (alreadyStaged.isFile()) {\n` +
    `                    logger.lifecycle("[copyForkLlamaLib] no source dir for \${abi}; libelizainference.so already staged in jniLibs — using the pre-staged fused lib set")\n` +
    `                    if (abi == 'arm64-v8a') stagedArm64 = true\n` +
    `                    return\n` +
    `                }\n` +
    `                if (abi == 'arm64-v8a') {\n` +
    `                    // arm64-v8a is the mandatory baseline ABI; missing it (and no pre-staged lib) is a hard error.\n` +
    `                    throw new GradleException("[copyForkLlamaLib] no fused inference lib for arm64-v8a (not configured, not pre-staged). Run packages/app-core/scripts/aosp/compile-libllama.mjs --target android-arm64-vulkan-fused (the Android cross-compiler; build-llama-cpp-mtp.mjs has no Android targets) or set -Peliza.mtp.android.libdir / ELIZA_MTP_ANDROID_LIBDIR.")\n` +
    `                }\n` +
    `                logger.lifecycle("[copyForkLlamaLib] no fork lib dir for ABI \${abi}; skipping")\n` +
    `                return\n` +
    `            }\n` +
    `            def srcDir = new File(libDir.toString())\n` +
    `            if (!srcDir.isDirectory()) {\n` +
    `                if (abi == 'arm64-v8a') {\n` +
    `                    throw new GradleException("[copyForkLlamaLib] MTP Android lib dir does not exist for arm64-v8a: \${libDir}")\n` +
    `                }\n` +
    `                logger.lifecycle("[copyForkLlamaLib] fork lib dir \${libDir} does not exist for ABI \${abi}; skipping")\n` +
    `                return\n` +
    `            }\n` +
    `            def jniDir = file("src/main/jniLibs/\${abi}")\n` +
    `            jniDir.mkdirs()\n` +
    `            def assetsDir = file('src/main/assets')\n` +
    `            assetsDir.mkdirs()\n` +
    `            int copied = 0\n` +
    `            srcDir.eachFile { src ->\n` +
    `                if (src.name.endsWith('.so')) {\n` +
    `                    def dst = new File(jniDir, src.name)\n` +
    `                    dst.bytes = src.bytes\n` +
    `                    copied++\n` +
    `                }\n` +
    `                // kernels.json is ABI-independent; stage once from the first ABI we see.\n` +
    `                if (src.name == 'kernels.json' && !stagedKernels) {\n` +
    `                    def dst = new File(assetsDir, 'llama-cpp-kernels.json')\n` +
    `                    dst.bytes = src.bytes\n` +
    `                    println "[copyForkLlamaLib] staged kernels.json as assets/llama-cpp-kernels.json (from \${abi})"\n` +
    `                    stagedKernels = true\n` +
    `                }\n` +
    `            }\n` +
    `            def libomp = resolveAndroidLibompForAbi(abi)\n` +
    `            if (libomp != null) {\n` +
    `                def dst = new File(jniDir, 'libomp.so')\n` +
    `                dst.bytes = libomp.bytes\n` +
    `                copied++\n` +
    `                println "[copyForkLlamaLib] staged Android OpenMP runtime for \${abi} from \${libomp}"\n` +
    `            } else if (abi == 'arm64-v8a') {\n` +
    `                throw new GradleException("[copyForkLlamaLib] Android arm64 libomp.so not found in the configured NDK; MTP CPU backend cannot load without it.")\n` +
    `            } else {\n` +
    `                logger.lifecycle("[copyForkLlamaLib] no libomp.so found for \${abi}; the .so set may not link on-device")\n` +
    `            }\n` +
    `            println "[copyForkLlamaLib] copied \${copied} .so file(s) from \${libDir} to \${jniDir}"\n` +
    `            totalCopied += copied\n` +
    `            if (abi == 'arm64-v8a') stagedArm64 = true\n` +
    `        }\n` +
    `        if (!stagedArm64) {\n` +
    `            throw new GradleException("[copyForkLlamaLib] arm64-v8a slice was not staged; aborting (this is the baseline ABI).")\n` +
    `        }\n` +
    `    }\n` +
    `}\n` +
    `\n` +
    `afterEvaluate {\n` +
    `    tasks.matching { it.name == 'preBuild' }.all { it.dependsOn copyForkLlamaLib }\n` +
    `}\n`;
  const androidOpen = content.search(/(^|\n)\s*android\s*\{/);
  if (androidOpen < 0) return content;
  let depth = 0;
  let i = content.indexOf("{", androidOpen);
  while (i < content.length) {
    const ch = content[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return content.slice(0, i + 1) + block + content.slice(i + 1);
      }
    }
    i += 1;
  }
  return content;
}

export function ensureCloudBuildAssetThinning(content) {
  if (/\[cloud-app-thinning\]/.test(content)) return content;
  return (
    content +
    `\n// [cloud-app-thinning] Cloud builds must never package the local agent payload.\n` +
    `// This second hook patches older generated projects whose existing\n` +
    `// [app-thinning] block only honored -PelizaStripAndroidAgentAssets.\n` +
    `afterEvaluate {\n` +
    `    tasks.matching { it.name.startsWith('merge') && it.name.endsWith('Assets') }.all { mergeTask ->\n` +
    `        mergeTask.inputs.property('elizaCloudBuild', project.findProperty('elizaCloudBuild') ?: 'false')\n` +
    `        mergeTask.doLast {\n` +
    `            if (project.findProperty('elizaCloudBuild') == 'true') {\n` +
    `                def assetsDir = mergeTask.outputDir.get().asFile\n` +
    `                def agentDir = new File(assetsDir, 'agent')\n` +
    `                if (agentDir.exists()) {\n` +
    `                    println "[cloud-app-thinning] removing assets/agent/ from \${mergeTask.name}"\n` +
    `                    agentDir.deleteDir()\n` +
    `                }\n` +
    `            }\n` +
    `        }\n` +
    `    }\n` +
    `}\n`
  );
}

export function injectAospAssetThinning(content) {
  if (/\[app-thinning\]/.test(content)) {
    return ensureCloudBuildAssetThinning(content);
  }
  const block =
    `\n// Optional app thinning: keep assets/agent/ by default so stock\n` +
    `// Capacitor APKs can run the bundled local agent. Set\n` +
    `// -PelizaStripAgentAssets=true only for an explicitly cloud-only slim APK.\n` +
    `afterEvaluate {\n` +
    `    tasks.matching { it.name.startsWith('merge') && it.name.endsWith('Assets') }.all { mergeTask ->\n` +
    `        mergeTask.inputs.property('elizaAospBuild', project.findProperty('elizaAospBuild') ?: 'false')\n` +
    `        mergeTask.inputs.property('elizaStripAgentAssets', project.findProperty('elizaStripAgentAssets') ?: 'false')\n` +
    `        mergeTask.inputs.property('elizaCloudBuild', project.findProperty('elizaCloudBuild') ?: 'false')\n` +
    `        mergeTask.doLast {\n` +
    `            if (project.findProperty('elizaAospBuild') != 'true' && (project.findProperty('elizaStripAgentAssets') == 'true' || project.findProperty('elizaCloudBuild') == 'true')) {\n` +
    `                def assetsDir = mergeTask.outputDir.get().asFile\n` +
    `                def agentDir = new File(assetsDir, 'agent')\n` +
    `                if (agentDir.exists()) {\n` +
    `                    println "[app-thinning] removing assets/agent/ from \${mergeTask.name} (cloud/slim Capacitor build)"\n` +
    `                    agentDir.deleteDir()\n` +
    `                }\n` +
    `            } else {\n` +
    `                println "[app-thinning] keeping assets/agent/ in \${mergeTask.name} (local-agent capable build)"\n` +
    `            }\n` +
    `        }\n` +
    `    }\n` +
    `}\n`;
  const androidOpen = content.search(/\n\s*android\s*\{/);
  if (androidOpen < 0) return content;
  let depth = 0;
  let i = content.indexOf("{", androidOpen);
  while (i < content.length) {
    const ch = content[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return content.slice(0, i + 1) + block + content.slice(i + 1);
      }
    }
    i += 1;
  }
  return ensureCloudBuildAssetThinning(content);
}

// llama-cpp-capacitor@0.1.5 is an arm64-only native package: its
// android/src/main/CMakeLists.txt unconditionally builds the arm64 target with
// `-march=armv8-a -mtune=cortex-a76`, and it ships only a
// jniLibs/arm64-v8a/libllama-cpp-arm64.so prebuilt — there is no x86_64 source
// path or prebuilt. Its build.gradle nonetheless declares
// `abiFilters 'arm64-v8a', 'x86_64'`, so AGP runs the arm64 NDK build under the
// x86_64 toolchain and clang rejects `-march=armv8-a` (unknown target CPU). Drop
// x86_64 from THIS library only, so the app still packages x86_64 for the other
// native libs (bun runtime, ggml) — llama-cpp-capacitor is simply absent there,
// which the plugin already tolerates.
export function restrictLlamaCapacitorToArm64(gradlePath) {
  if (!fs.existsSync(gradlePath)) return;
  const current = fs.readFileSync(gradlePath, "utf8");
  const patched = current
    .replace(/(abiFilters\s+'arm64-v8a')\s*,\s*'x86_64'/g, "$1")
    .replace(
      /abiFilters\s+'x86_64'\s*,\s*'arm64-v8a'/g,
      "abiFilters 'arm64-v8a'",
    );
  if (patched !== current) {
    fs.writeFileSync(gradlePath, patched, "utf8");
    console.log(
      "[mobile-build] Restricted llama-cpp-capacitor to arm64-v8a (package has no x86_64 native build).",
    );
  }
}

export function injectAndroidBackgroundRunnerAarFlatDir(content) {
  if (/flatDir\s*\{[\s\S]*?dirs[\s\S]*?['"]libs['"][\s\S]*?\}/.test(content)) {
    return content;
  }
  if (/flatDir\s*\{\s*\n\s*dirs\s+/.test(content)) {
    return content.replace(
      /(flatDir\s*\{\s*\n\s*dirs\s+)/,
      "$1'libs',\n             ",
    );
  }
  return content.replace(
    /\nrepositories\s*\{\s*\n/,
    "\nrepositories {\n    flatDir { dirs 'libs' }\n",
  );
}

export function patchGradleFileForAgp9(filePath, label) {
  if (!fs.existsSync(filePath)) return;
  const current = fs.readFileSync(filePath, "utf8");
  const patched = current
    .replace(
      /^\s*apply plugin:\s*['"](org\.jetbrains\.kotlin\.android|kotlin-android)['"]\s*\r?\n/gm,
      "",
    )
    .replace(/\n\s*kotlin\s*\{\s*jvmToolchain\(\d+\)\s*\}\s*/g, "\n")
    .replace(
      /getDefaultProguardFile\('proguard-android\.txt'\)/g,
      "getDefaultProguardFile('proguard-android-optimize.txt')",
    );
  if (patched !== current) {
    fs.writeFileSync(filePath, patched, "utf8");
    console.log(`[mobile-build] Patched ${label} Gradle for AGP 9.`);
  }
}

export function ensureGradleProperty(content, key, value) {
  const re = new RegExp(`^${escapeRegExp(key)}=.*$`, "m");
  if (re.test(content)) return content.replace(re, `${key}=${value}`);
  return `${content.replace(/\s*$/, "")}\n${key}=${value}\n`;
}

export function applyAndroidGeneratedBuildTargetProperties(
  content,
  { cloudBuild = false } = {},
) {
  const withoutPreviousCloudMarker = content.replace(
    /^elizaCloudBuild=.*\n?/gm,
    "",
  );
  return cloudBuild
    ? ensureGradleProperty(
        withoutPreviousCloudMarker,
        "elizaCloudBuild",
        "true",
      )
    : withoutPreviousCloudMarker;
}

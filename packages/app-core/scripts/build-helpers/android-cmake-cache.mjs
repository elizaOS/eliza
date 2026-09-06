/** Binds Android CMake caches to their selected NDK and checks the configured compiler before building. */
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";

export function androidCmakeBuildDirectory({
  cacheRoot,
  ndk,
  abi,
  platform,
  variant,
}) {
  const resolvedNdk = realpathSync(ndk);
  const identity = createHash("sha256")
    .update(
      JSON.stringify({
        ndk: resolvedNdk,
        toolchain: readFileSync(
          path.join(resolvedNdk, "build/cmake/android.toolchain.cmake"),
          "utf8",
        ),
        properties: readFileSync(
          path.join(resolvedNdk, "source.properties"),
          "utf8",
        ),
        abi,
        platform,
        variant,
      }),
    )
    .digest("hex");
  return path.join(cacheRoot, `${abi}-${variant}-${identity}`);
}

export function assertAndroidCmakeCompilers({ buildDir, ndk }) {
  const cache = readFileSync(path.join(buildDir, "CMakeCache.txt"), "utf8");
  const version = ["MAJOR", "MINOR", "PATCH"]
    .map((part) => {
      const match = cache.match(
        new RegExp(`^CMAKE_CACHE_${part}_VERSION:INTERNAL=(\\d+)\\r?$`, "m"),
      );
      if (!match)
        throw new Error(`CMake version metadata is missing in ${buildDir}`);
      return match[1];
    })
    .join(".");
  const resolvedNdk = realpathSync(ndk);
  const compilers = {};
  for (const language of ["C", "CXX"]) {
    const metadata = readFileSync(
      path.join(
        buildDir,
        "CMakeFiles",
        version,
        `CMake${language}Compiler.cmake`,
      ),
      "utf8",
    );
    const match = metadata.match(
      new RegExp(`^set\\(CMAKE_${language}_COMPILER "([^"]+)"\\)`, "m"),
    );
    if (!match)
      throw new Error(
        `CMake ${language} compiler metadata is missing in ${buildDir}`,
      );
    const compiler = realpathSync(match[1]);
    const relative = path.relative(resolvedNdk, compiler);
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error(
        `CMake ${language} compiler ${compiler} does not belong to selected NDK ${resolvedNdk}; use a fresh build directory`,
      );
    }
    compilers[language] = compiler;
  }
  return compilers;
}

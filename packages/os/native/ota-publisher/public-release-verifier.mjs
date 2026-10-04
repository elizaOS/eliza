import { createHash } from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import { parseDescriptorJson } from "./strict-json.mjs";

const LIMIT = 1024 * 1024;
function requireValue(ok, message) {
  if (!ok) throw Error(`OTA publication: ${message}`);
}
const sha = (value) =>
  typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
// Anonymous, fixed-origin, no redirects, bounded response/time. Never consumes
// GH_TOKEN, GITHUB_TOKEN, cookies or credentials from a device or environment.
export function createPublicReleaseVerifier({
  validateRelease,
  userAgent,
} = {}) {
  requireValue(
    typeof validateRelease === "function",
    "host descriptor validator required",
  );
  requireValue(
    typeof userAgent === "string" &&
      /^[a-zA-Z0-9][a-zA-Z0-9 ._/-]{0,127}$/.test(userAgent),
    "host user agent required",
  );
  function readPublicGitHubJSON(endpoint, budgetMs = 15000) {
    requireValue(
      /^\/repos\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._/-]+)*(?:\?per_page=100&page=[1-9]\d?)?$/.test(
        endpoint,
      ),
      "invalid API path",
    );
    requireValue(
      !endpoint
        .split("?")[0]
        .split("/")
        .some((part) => part === "." || part === ".."),
      "API traversal forbidden",
    );
    return new Promise((resolve, reject) => {
      const request = https.get(
        {
          hostname: "api.github.com",
          port: 443,
          path: endpoint,
          headers: {
            Accept: "application/vnd.github+json",
            "User-Agent": userAgent,
            "X-GitHub-Api-Version": "2026-03-10",
            "Cache-Control": "no-cache",
          },
        },
        (response) => {
          if (response.statusCode !== 200) {
            const error = Error(
              `GitHub public read failed (${response.statusCode}); publication deferred`,
            );
            const retry = response.headers["retry-after"];
            if (typeof retry === "string" && /^\d+$/.test(retry))
              error.retryAfterSeconds = Math.min(Number(retry), 86400);
            response.destroy();
            reject(error);
            return;
          }
          if (
            !/^application\/(?:vnd\.github\+)?json\b/i.test(
              response.headers["content-type"] ?? "",
            )
          ) {
            response.destroy();
            reject(Error("GitHub response is not JSON"));
            return;
          }
          const chunks = [];
          let size = 0;
          response.on("error", reject);
          response.on("data", (chunk) => {
            size += chunk.length;
            if (size > LIMIT) {
              response.destroy(Error("GitHub response exceeds byte budget"));
              return;
            }
            chunks.push(chunk);
          });
          response.on("end", () => {
            try {
              resolve(parseDescriptorJson(Buffer.concat(chunks)));
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      const timer = setTimeout(
        () => request.destroy(Error("GitHub publication read timed out")),
        Math.max(1, Math.min(budgetMs, 15000)),
      );
      timer.unref();
      request.on("error", reject);
      request.on("close", () => clearTimeout(timer));
    });
  }
  /** Readback barrier before authorizing a metadata publication. API digest
   * observations complement, never replace, the local APK byte/signature gate.
   * readJSON injection is for tests; the CLI always uses the anonymous transport. */
  async function verifyPublicRelease(
    descriptor,
    { hosts, readJSON = readPublicGitHubJSON } = {},
  ) {
    const d = validateRelease(descriptor, { artifactHosts: new Set(hosts) }),
      base = `/repos/${d.source.repository}`;
    const started = performance.now();
    let requests = 0;
    const read = async (endpoint) => {
      requireValue(++requests <= 16, "request budget exhausted");
      const remaining = 60000 - (performance.now() - started);
      requireValue(remaining > 0, "publication read deadline exceeded");
      const result = await readJSON(endpoint, remaining);
      requireValue(
        performance.now() - started <= 60000,
        "publication read deadline exceeded",
      );
      return result;
    };
    const repository = await read(base);
    requireValue(
      repository?.private === false &&
        repository.full_name?.toLowerCase() ===
          d.source.repository.toLowerCase(),
      "repository is not the expected public source",
    );
    const release = await read(`${base}/releases/tags/${d.source.tag}`);
    const releaseOK = (r) =>
      r &&
      Number.isSafeInteger(r.id) &&
      r.id > 0 &&
      r.draft === false &&
      r.immutable === true &&
      r.tag_name === d.source.tag &&
      typeof r.published_at === "string" &&
      Number.isFinite(Date.parse(r.published_at));
    requireValue(releaseOK(release), "release must be published and immutable");
    // target_commitish can be a branch and does not prove the existing tag target.
    const ref = await read(`${base}/git/ref/tags/${d.source.tag}`);
    requireValue(
      ref?.ref === `refs/tags/${d.source.tag}`,
      "tag identity mismatch",
    );
    let object = ref.object;
    const visited = new Set();
    for (let depth = 0; object?.type === "tag"; depth++) {
      requireValue(
        depth < 8 && sha(object.sha) && !visited.has(object.sha),
        "invalid/cyclic annotated tag",
      );
      visited.add(object.sha);
      const tag = await read(`${base}/git/tags/${object.sha}`);
      requireValue(tag?.sha === object.sha, "annotated tag identity mismatch");
      object = tag.object;
    }
    requireValue(
      object?.type === "commit" &&
        sha(object.sha) &&
        object.sha === d.source.commit,
      "tag does not resolve to reviewed source commit",
    );
    const assets = [],
      names = new Set(),
      ids = new Set();
    let complete = false;
    for (let page = 1; page <= 10; page++) {
      const rows = await read(
        `${base}/releases/${release.id}/assets?per_page=100&page=${page}`,
      );
      requireValue(
        Array.isArray(rows) && rows.length <= 100,
        "invalid asset page",
      );
      for (const asset of rows) {
        requireValue(
          asset &&
            typeof asset.name === "string" &&
            Number.isSafeInteger(asset.id) &&
            asset.id > 0 &&
            !names.has(asset.name) &&
            !ids.has(asset.id),
          "duplicate/invalid release asset",
        );
        names.add(asset.name);
        ids.add(asset.id);
        assets.push(asset);
      }
      if (rows.length < 100) {
        complete = true;
        break;
      }
    }
    requireValue(complete, "asset listing exceeds publication budget");
    const subjects = {};
    for (const name of ["candidate", "recovery"]) {
      const expected = d[name],
        filename = new URL(expected.url).pathname.split("/").at(-1),
        asset = assets.find((a) => a.name === filename);
      requireValue(
        asset?.state === "uploaded" &&
          asset.browser_download_url === expected.url &&
          asset.size === expected.length &&
          asset.digest === `sha256:${expected.sha256}`,
        `${name} asset is missing, incomplete or mismatched`,
      );
      subjects[name] = {
        id: asset.id,
        url: asset.browser_download_url,
        length: asset.size,
        sha256: expected.sha256,
      };
    }
    // Recheck publication state after listing. This cannot make GitHub and the
    // metadata origin atomic; clients must still tolerate later deletion/outage.
    const final = await read(`${base}/releases/${release.id}`);
    requireValue(
      releaseOK(final) &&
        final.id === release.id &&
        final.published_at === release.published_at,
      "release changed during verification",
    );
    return {
      publicReleaseVerified: true,
      artifactBytesVerified: false,
      metadataAuthenticated: false,
      repository: d.source.repository,
      tag: d.source.tag,
      commit: object.sha,
      releaseId: release.id,
      subjects,
      requests,
      scope:
        "Anonymous GitHub API readback only. Requires local APK gate and fresh recheck immediately before signed metadata publication; CDN availability and cross-service atomicity are not established.",
    };
  }
  async function verifyPublicReleaseFile(file, { hosts } = {}) {
    const fd = fs.openSync(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    let bytes;
    try {
      const stat = fs.fstatSync(fd);
      requireValue(
        stat.isFile() && stat.size > 0 && stat.size <= LIMIT,
        "bounded regular descriptor required",
      );
      bytes = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < bytes.length) {
        const n = fs.readSync(fd, bytes, offset, bytes.length - offset, null);
        requireValue(n > 0, "descriptor changed");
        offset += n;
      }
      requireValue(
        fs.readSync(fd, Buffer.alloc(1), 0, 1, null) === 0,
        "descriptor grew",
      );
    } finally {
      fs.closeSync(fd);
    }
    const result = await verifyPublicRelease(parseDescriptorJson(bytes), {
      hosts,
    });
    return {
      ...result,
      descriptorSha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }
  return Object.freeze({
    readPublicGitHubJSON,
    verifyPublicRelease,
    verifyPublicReleaseFile,
  });
}

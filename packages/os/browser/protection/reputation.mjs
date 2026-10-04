/* Phishing.Database data license (retained in native staging):
MIT License

Copyright (c) 2018-2025 Mitchell Krog - github.com/mitchellkrogza
Copyright (c) 2018-2025 Nissar Chababy - github.com/funilrys
Copyright (c) 2018-2025 Phishing.Database Contributors - github.com/Phishing-Database

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import {
  downloadThreatFeed,
  parseThreatDomains,
  validFeedTime,
} from "./policy.mjs";

const HOUR = 3600000,
  MAX_BYTES = 24 * 1024 * 1024;
const unavailable = (reason) => ({ status: "unavailable", reason });
const digest = (body) => createHash("sha256").update(body).digest("hex");
/** Only fixed public feeds are downloaded. Never fetch, persist or transmit visited URLs. */
export function createWebsiteReputation({
  fetchImpl = fetch,
  now = Date.now,
  minEntries = 1000,
  cacheDir = null,
  feeds = [],
  userAgent = "Eliza-Browser-Protection",
} = {}) {
  if (
    !Array.isArray(feeds) ||
    !feeds.length ||
    feeds.length > 8 ||
    new Set(feeds.map((feed) => feed.id)).size !== feeds.length ||
    feeds.some((feed) => !/^[-a-z0-9]{1,64}$/.test(feed.id))
  )
    throw Error("Invalid reputation feed configuration");
  const states = feeds.map((feed) => ({
    feed,
    snapshot: null,
    pending: null,
    retryAfter: 0,
  }));
  let timer = null,
    stopped = false;
  const validTime = (time) => validFeedTime(time, now());
  const usable = (s) =>
    s && validTime(s.publishedAt) && validTime(s.downloadedAt);
  const fresh = (s) => usable(s) && now() - s.downloadedAt < 6 * HOUR;
  function parse(body, publishedAt, downloadedAt) {
    if (
      Buffer.byteLength(body) > MAX_BYTES ||
      !validTime(publishedAt) ||
      !validTime(downloadedAt)
    )
      throw Error("expired or oversized feed");
    const domains = parseThreatDomains(body, minEntries);
    return { domains, publishedAt, downloadedAt };
  }
  const loaded = Promise.all(
    states.map(async (state) => {
      if (!cacheDir) return;
      try {
        const path = join(cacheDir, `${state.feed.id}.json`);
        if ((await stat(path)).size > MAX_BYTES * 2)
          throw Error("oversized cache");
        const data = JSON.parse(await readFile(path, "utf8"));
        if (
          data.version !== 1 ||
          data.url !== state.feed.url ||
          typeof data.body !== "string" ||
          data.sha256 !== digest(data.body)
        )
          throw Error("invalid cache");
        state.snapshot = parse(data.body, data.publishedAt, data.downloadedAt);
      } catch {
        /* Missing/corrupt/expired data is never a clean result. */
      }
    }),
  );
  async function download(feed) {
    const { body, publishedAt, downloadedAt } = await downloadThreatFeed(feed, {
      fetchImpl,
      now,
      minEntries,
      userAgent,
    });
    return { body, snapshot: parse(body, publishedAt, downloadedAt) };
  }
  async function refresh(state) {
    let temporary;
    try {
      const { body, snapshot } = await download(state.feed);
      state.snapshot = snapshot;
      if (cacheDir) {
        await mkdir(cacheDir, { recursive: true, mode: 0o700 });
        temporary = join(cacheDir, `${state.feed.id}.${randomUUID()}.tmp`);
        await writeFile(
          temporary,
          JSON.stringify({
            version: 1,
            url: state.feed.url,
            license: state.feed.license,
            licenseUrl: state.feed.licenseUrl,
            publishedAt: snapshot.publishedAt,
            downloadedAt: snapshot.downloadedAt,
            sha256: digest(body),
            body,
          }),
          { mode: 0o600, flag: "wx" },
        );
        await rename(temporary, join(cacheDir, `${state.feed.id}.json`));
        temporary = null;
      }
    } catch {
      /* A failed download or write never extends an existing snapshot's expiry. */
    } finally {
      if (temporary) await unlink(temporary).catch(() => {});
      state.retryAfter = now() + 60000;
    }
  }
  function update(state) {
    if (!state.pending && !stopped && now() >= state.retryAfter)
      state.pending = refresh(state).finally(() => {
        state.pending = null;
      });
    return state.pending;
  }
  async function warmup() {
    await loaded;
    await Promise.all(states.filter((s) => !fresh(s.snapshot)).map(update));
  }
  const check = async (input) => {
    if (typeof input !== "string" || input.length > 4096)
      return unavailable("invalid-address");
    let url;
    try {
      url = new URL(input);
    } catch {
      return unavailable("invalid-address");
    }
    if (url.protocol !== "https:" || url.username || url.password)
      return unavailable("invalid-address");
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (!host.includes(".") || /^[\d.]+$/.test(host) || host.startsWith("["))
      return unavailable("local-address");
    await loaded;
    await Promise.all(
      states.map(async (state) => {
        if (!fresh(state.snapshot)) {
          const work = update(state);
          if (!usable(state.snapshot)) await work;
        }
      }),
    );
    // A match from either current feed blocks even when the other is unavailable.
    for (const { snapshot, feed } of states) {
      if (!usable(snapshot)) continue;
      let candidate = host;
      while (candidate.includes(".")) {
        if (snapshot.domains.has(candidate))
          return {
            status: "blocked",
            source: feed.source,
            scope: "domain",
            threats: feed.threats,
          };
        candidate = candidate.slice(candidate.indexOf(".") + 1);
      }
    }
    if (states.some((state) => !usable(state.snapshot)))
      return unavailable("feed-unavailable");
    return {
      status: "no-known-threat",
      source: states.map((s) => s.feed.source).join(" + "),
      scope: "domain",
    };
  };
  check.warmup = warmup;
  check.start = () => {
    if (timer) return;
    stopped = false;
    void warmup();
    timer = setInterval(() => void warmup(), HOUR);
    timer.unref();
  };
  check.stop = () => {
    stopped = true;
    clearInterval(timer);
    timer = null;
  };
  return check;
}

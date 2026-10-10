/** Read public X posts through official oEmbed, without account credentials. */
import {
  type Action,
  ElizaError,
  fetchRemoteMedia,
  type Plugin,
} from "@elizaos/core";
import { runWebSearchEdge } from "@elizaos/plugin-web-search";
import { Parser } from "htmlparser2";

function parsePublicUrl(input: string, base?: string): URL | undefined {
  try {
    return new URL(input, base);
  } catch {
    // error-policy:J3 Malformed public input is rejected, never repaired.
    return undefined;
  }
}

const profileName = (value: string) =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

/** Public indexes and profile titles identify candidates; oEmbed verifies each post. */
export async function discoverPublicXPosts(
  subject: string,
  signal?: AbortSignal,
) {
  if (!/^[A-Za-z0-9_ .-]{1,50}$/.test(subject))
    throw new ElizaError("A public account name or handle is required.", {
      code: "X_PUBLIC_SUBJECT_INVALID",
    });
  const search = await runWebSearchEdge(
    `${subject} public profile posts site:x.com`,
    { signal },
  );
  if (!search.success)
    throw new ElizaError("Public X discovery is unavailable.", {
      code: "X_PUBLIC_DISCOVERY_UNAVAILABLE",
    });
  const receipts = search.data?.sources;
  if (!Array.isArray(receipts))
    throw new ElizaError("Public X discovery has no source receipts.", {
      code: "X_PUBLIC_DISCOVERY_UNBOUND",
    });
  const handles = new Map<string, Set<string>>();
  for (const receipt of receipts) {
    if (
      !receipt ||
      typeof receipt !== "object" ||
      typeof receipt.url !== "string"
    )
      continue;
    const url = parsePublicUrl(receipt.url);
    if (url?.protocol !== "https:" || url.username || url.password) continue;
    const match = url.pathname.match(
      /^\/([A-Za-z0-9_]{1,15})(?:\/status\/(\d{15,22}))?\/?$/,
    );
    if (
      !["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(
        url.hostname,
      ) ||
      !match ||
      ["i", "home", "search", "intent"].includes(match[1].toLowerCase())
    )
      continue;
    const ids = handles.get(match[1]) ?? new Set<string>();
    if (match[2]) ids.add(match[2]);
    handles.set(match[1], ids);
  }
  if (/^[A-Za-z0-9_]{1,15}$/.test(subject) && !handles.has(subject))
    handles.set(subject, new Set());
  const profiles = [];
  const posts = [];
  const gaps: string[] = [];
  for (const [handle, ids] of handles) {
    signal?.throwIfAborted();
    const profileUrl = `https://x.com/${handle}`;
    try {
      const { buffer } = await fetchRemoteMedia({
        url: profileUrl,
        maxBytes: 1_000_000,
        signal,
      });
      let title = "";
      let inTitle = false;
      const parser = new Parser(
        {
          onopentag(name) {
            if (name === "title") inTitle = true;
          },
          ontext(text) {
            if (inTitle) title += text;
          },
          onclosetag(name) {
            if (name === "title") inTitle = false;
          },
        },
        { decodeEntities: true },
      );
      const page = buffer.toString("utf8");
      parser.write(page);
      parser.end();
      const display = title.split("(@")[0].trim();
      if (
        profileName(subject) !== profileName(handle) &&
        profileName(subject) !== profileName(display)
      )
        continue;
      profiles.push({ url: profileUrl, handle, display, title });
      // All indexed candidates are retained. Each selected body is
      // separately attributed and dated through the official endpoint.
      for (const id of ids) {
        signal?.throwIfAborted();
        try {
          posts.push(
            await readPublicXPost(
              `https://x.com/${handle}/status/${id}`,
              signal,
            ),
          );
        } catch (error) {
          signal?.throwIfAborted();
          // error-policy:J2 An inaccessible candidate is a coverage gap, not an empty timeline.
          gaps.push(
            `Public candidate ${id} could not be verified: ${error instanceof ElizaError ? error.code : "read failed"}`,
          );
        }
      }
    } catch (error) {
      signal?.throwIfAborted();
      // error-policy:J2 A blocked public profile does not authorize a login or private read.
      gaps.push(
        `Public profile ${handle} could not be read: ${error instanceof ElizaError ? error.code : "read failed"}`,
      );
    }
  }
  posts.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  return {
    posts,
    profiles,
    gaps,
    discoveryReceipt: search.data,
    coverage:
      "Public index and accessible profile candidates only. The newest verified candidate is not a complete timeline or global-latest guarantee.",
  };
}

export async function readPublicXPost(input: string, signal?: AbortSignal) {
  const url = parsePublicUrl(input);
  const match = url?.pathname.match(
    /^\/([A-Za-z0-9_]{1,15})\/status\/(\d{15,22})\/?$/,
  );
  if (
    url?.protocol !== "https:" ||
    url.username ||
    url.password ||
    !["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(
      url.hostname,
    ) ||
    !match
  ) {
    throw new ElizaError("A public X post URL is required.", {
      code: "X_PUBLIC_POST_URL_INVALID",
    });
  }
  const [, handle, id] = match;
  const canonicalUrl = `https://x.com/${handle}/status/${id}`;
  const endpoint = new URL("https://publish.x.com/oembed");
  endpoint.search = new URLSearchParams({
    url: canonicalUrl,
    omit_script: "true",
    hide_thread: "true",
  }).toString();
  const { buffer } = await fetchRemoteMedia({
    url: endpoint.toString(),
    maxBytes: 100_000,
    signal,
  });
  const result: {
    author_url?: unknown;
    author_name?: unknown;
    html?: unknown;
  } = JSON.parse(buffer.toString("utf8"));
  if (
    typeof result.author_url !== "string" ||
    typeof result.html !== "string"
  ) {
    throw new ElizaError("Public X post metadata is incomplete.", {
      code: "X_PUBLIC_POST_INCOMPLETE",
    });
  }
  const author = parsePublicUrl(result.author_url);
  if (
    !author ||
    !["x.com", "twitter.com"].includes(author.hostname) ||
    author.pathname.replace(/^\//, "").toLowerCase() !== handle.toLowerCase()
  ) {
    throw new ElizaError("Public X post author does not match its URL.", {
      code: "X_PUBLIC_POST_AUTHOR_MISMATCH",
    });
  }
  let body = "";
  let dateText = "";
  let inBody = false;
  let inDate = false;
  const parser = new Parser(
    {
      onopentag(name, attributes) {
        if (name === "p") inBody = true;
        if (name === "br" && inBody) body += "\n";
        if (name === "a" && !inBody && attributes.href) {
          const link = parsePublicUrl(attributes.href, canonicalUrl);
          inDate = Boolean(
            link &&
              ["x.com", "twitter.com"].includes(link.hostname) &&
              link.pathname === `/${handle}/status/${id}`,
          );
        }
      },
      ontext(text) {
        if (inBody) body += text;
        else if (inDate) dateText += text;
      },
      onclosetag(name) {
        if (name === "p") inBody = false;
        if (name === "a") inDate = false;
      },
    },
    { decodeEntities: true },
  );
  parser.write(result.html);
  parser.end();
  const timestamp = Number((BigInt(id) >> 22n) + 1288834974657n);
  const date = new Date(timestamp);
  const embedDate = Date.parse(`${dateText.trim()} 00:00:00 GMT`);
  if (
    !body.trim() ||
    !Number.isFinite(timestamp) ||
    timestamp > Date.now() + 60_000 ||
    !Number.isFinite(embedDate) ||
    new Date(embedDate).toISOString().slice(0, 10) !==
      date.toISOString().slice(0, 10)
  ) {
    throw new ElizaError("Public X post body or date could not be verified.", {
      code: "X_PUBLIC_POST_UNVERIFIED",
    });
  }
  return {
    url: canonicalUrl,
    handle,
    author: result.author_name,
    body: body.trim(),
    publishedAt: date.toISOString(),
    dateAuthority:
      "X status ID creation time corroborated by the official oEmbed calendar date.",
    coverage:
      "One accessible public post. No complete timeline or latest-post guarantee.",
  };
}

export const readPublicXPostAction: Action = {
  name: "READ_PUBLIC_X_POST",
  similes: ["READ_PUBLIC_TWEET"],
  tags: ["resource:x", "capability:read"],
  contexts: ["general"],
  roleGate: { minRole: "GUEST" },
  description:
    "Read the full body and author of one public X post through official oEmbed. Does not log in, read private posts, or establish the latest post on an account.",
  parameters: [
    {
      name: "url",
      description: "Public X status URL to read.",
      required: true,
      schema: { type: "string" },
    },
  ],
  validate: async () => true,
  handler: async (_runtime, _message, _state, options) => {
    const params = options?.parameters as Record<string, unknown> | undefined;
    if (typeof params?.url !== "string")
      throw new ElizaError("A public X post URL is required.", {
        code: "X_PUBLIC_POST_URL_REQUIRED",
      });
    const signal =
      options?.abortSignal instanceof AbortSignal
        ? options.abortSignal
        : undefined;
    const post = await readPublicXPost(params.url, signal);
    const text = JSON.stringify(post);
    return {
      success: true,
      text,
      modelReplyRequired: true,
      data: {
        actionName: "READ_PUBLIC_X_POST",
        post,
        sources: [{ url: post.url, text }],
      },
    };
  },
};

export const discoverPublicXPostsAction: Action = {
  name: "DISCOVER_PUBLIC_X_POSTS",
  similes: ["LATEST_PUBLIC_X_POSTS"],
  tags: ["resource:x", "capability:read"],
  contexts: ["general"],
  roleGate: { minRole: "GUEST" },
  description:
    "Find public indexed posts for a matching account, verify accessible bodies and dates through official oEmbed, and order them by publication time. Does not guarantee the globally latest post or a complete account timeline.",
  parameters: [
    {
      name: "subject",
      description: "Explicit public account name or handle to look up.",
      required: true,
      schema: { type: "string" },
    },
  ],
  validate: async () => true,
  handler: async (_runtime, _message, _state, options) => {
    const params = options?.parameters as Record<string, unknown> | undefined;
    if (typeof params?.subject !== "string")
      throw new ElizaError("A public account name is required.", {
        code: "X_PUBLIC_SUBJECT_REQUIRED",
      });
    const result = await discoverPublicXPosts(
      params.subject,
      options?.abortSignal instanceof AbortSignal
        ? options.abortSignal
        : undefined,
    );
    return {
      success: true,
      text: JSON.stringify(result),
      modelReplyRequired: true,
      data: {
        actionName: "DISCOVER_PUBLIC_X_POSTS",
        ...result,
        sources: result.posts.map((post) => ({
          url: post.url,
          text: JSON.stringify(post),
        })),
      },
    };
  },
};

export const publicXPlugin: Plugin = {
  name: "x-public",
  description: "Credential-free public X post reads.",
  actions: [readPublicXPostAction, discoverPublicXPostsAction],
};
export default publicXPlugin;

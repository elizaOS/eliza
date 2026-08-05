const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/u;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.WAITLIST)
    return json({ error: "Waitlist is temporarily unavailable." }, 503);

  const origin = request.headers.get("origin");
  const requestOrigin = new URL(request.url).origin;
  if (origin && origin !== requestOrigin)
    return json({ error: "Origin not allowed." }, 403);

  let input;
  try {
    const contentType = request.headers.get("content-type") || "";
    if (contentType.includes("application/json")) input = await request.json();
    else input = Object.fromEntries(await request.formData());
  } catch {
    return json({ error: "Invalid request." }, 400);
  }

  if (
    typeof input?.companyWebsite === "string" &&
    input.companyWebsite.trim()
  ) {
    return json({ ok: true });
  }

  const email =
    typeof input?.email === "string" ? input.email.trim().toLowerCase() : "";
  if (email.length > 254 || !EMAIL_PATTERN.test(email))
    return json({ error: "Enter a valid email address." }, 400);

  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const ipHash = await sha256(ip);
  const rateKey = `rate:${ipHash}`;
  if (await env.WAITLIST.get(rateKey))
    return json({ error: "Please wait a moment and try again." }, 429);
  await env.WAITLIST.put(rateKey, "1", { expirationTtl: 10 });

  const emailHash = await sha256(email);
  const key = `email:${emailHash}`;
  if (await env.WAITLIST.get(key))
    return json({ ok: true, alreadyJoined: true });

  const submittedAt = new Date().toISOString();
  await env.WAITLIST.put(
    key,
    JSON.stringify({
      email,
      submittedAt,
      source:
        typeof input?.source === "string"
          ? input.source.slice(0, 80)
          : "eliza.app",
      referrer: (request.headers.get("referer") || "").slice(0, 500),
    }),
    { metadata: { submittedAt, source: "eliza.app" } },
  );

  return json({ ok: true });
}

export function onRequest() {
  return json({ error: "Method not allowed." }, 405);
}

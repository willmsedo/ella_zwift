const WEBHOOK_PATH = "/strava/webhook";

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function isAdmin(request, env) {
  return Boolean(env.ADMIN_TOKEN) &&
    request.headers.get("Authorization") === `Bearer ${env.ADMIN_TOKEN}`;
}

function handleWebhookVerification(url, env) {
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  if (mode !== "subscribe" || !env.VERIFY_TOKEN || token !== env.VERIFY_TOKEN || !challenge) {
    return jsonResponse({ error: "Webhook verification failed." }, 403);
  }
  return jsonResponse({ "hub.challenge": challenge });
}

async function readLimitedBody(request, limit) {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function handleWebhookEvent(request, env) {
  const declaredLength = Number(request.headers.get("Content-Length") || 0);
  if (declaredLength > 65536) return jsonResponse({ error: "Event is too large." }, 413);
  let event;
  try {
    const body = await readLimitedBody(request, 65536);
    if (body === null) return jsonResponse({ error: "Event is too large." }, 413);
    event = JSON.parse(body);
  } catch {
    return jsonResponse({ error: "Invalid JSON event." }, 400);
  }
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return jsonResponse({ error: "Invalid event object." }, 400);
  }

  if (event.object_type === "athlete" &&
      (event.updates?.authorized === false || event.updates?.authorized === "false")) {
    if (!env.WEBHOOK_STATE) return jsonResponse({ error: "Webhook state storage is unavailable." }, 503);
    const subscriptionId = await env.WEBHOOK_STATE.get("subscription_id");
    if (!subscriptionId || String(event.subscription_id) !== subscriptionId) {
      return jsonResponse({ error: "Unknown webhook subscription." }, 403);
    }
    await env.WEBHOOK_STATE.put("revoked", "true");
  }
  return jsonResponse({ received: true });
}

async function registerSubscription(url, env) {
  if (!env.STRAVA_CLIENT_ID || !env.STRAVA_CLIENT_SECRET || !env.VERIFY_TOKEN) {
    return jsonResponse({ error: "Strava webhook secrets are not configured." }, 503);
  }
  if (!env.WEBHOOK_STATE) return jsonResponse({ error: "Webhook state storage is unavailable." }, 503);

  const callbackUrl = `${url.origin}${WEBHOOK_PATH}`;
  const query = new URLSearchParams({
    client_id: env.STRAVA_CLIENT_ID,
    client_secret: env.STRAVA_CLIENT_SECRET,
  });
  const listResponse = await fetch(`https://www.strava.com/api/v3/push_subscriptions?${query}`);
  if (!listResponse.ok) {
    return jsonResponse({ error: `Strava subscription lookup failed (HTTP ${listResponse.status}).` }, 502);
  }
  const subscriptions = await listResponse.json();
  if (!Array.isArray(subscriptions)) {
    return jsonResponse({ error: "Strava returned an invalid subscription list." }, 502);
  }
  const existing = subscriptions.find((subscription) =>
    subscription.callback_url === callbackUrl
  );
  if (existing) {
    await env.WEBHOOK_STATE.put("subscription_id", String(existing.id));
    await env.WEBHOOK_STATE.put("revoked", "false");
    return jsonResponse({ registered: true, subscription_id: existing.id, already_registered: true });
  }
  if (subscriptions.length) {
    return jsonResponse({
      error: "This Strava app already has a webhook subscription at a different callback URL. Remove or migrate it before registering this endpoint.",
    }, 409);
  }

  const fields = new URLSearchParams({
    client_id: env.STRAVA_CLIENT_ID,
    client_secret: env.STRAVA_CLIENT_SECRET,
    callback_url: callbackUrl,
    verify_token: env.VERIFY_TOKEN,
  });
  const createResponse = await fetch("https://www.strava.com/api/v3/push_subscriptions", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: fields,
  });
  const result = await createResponse.json().catch(() => ({}));
  if (!createResponse.ok) {
    return jsonResponse({
      error: `Strava subscription registration failed (HTTP ${createResponse.status}).`,
      details: result,
    }, 502);
  }
  await env.WEBHOOK_STATE.put("subscription_id", String(result.id));
  await env.WEBHOOK_STATE.put("revoked", "false");
  return jsonResponse({ registered: true, subscription_id: result.id, already_registered: false });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === WEBHOOK_PATH && request.method === "GET") {
        return handleWebhookVerification(url, env);
      }
      if (url.pathname === WEBHOOK_PATH && request.method === "POST") {
        return handleWebhookEvent(request, env);
      }
      if (!url.pathname.startsWith("/admin/")) {
        return jsonResponse({ error: "Not found." }, 404);
      }
      if (!isAdmin(request, env)) return jsonResponse({ error: "Unauthorized." }, 401);
      if (url.pathname === "/admin/state" && request.method === "GET") {
        if (!env.WEBHOOK_STATE) return jsonResponse({ error: "Webhook state storage is unavailable." }, 503);
        const [subscriptionId, revoked] = await Promise.all([
          env.WEBHOOK_STATE.get("subscription_id"),
          env.WEBHOOK_STATE.get("revoked"),
        ]);
        return jsonResponse({
          subscription_id: subscriptionId,
          revoked: revoked === "true",
        });
      }
      if (url.pathname === "/admin/register" && request.method === "POST") {
        return registerSubscription(url, env);
      }
      if (url.pathname === "/admin/reset" && request.method === "POST") {
        if (!env.WEBHOOK_STATE) return jsonResponse({ error: "Webhook state storage is unavailable." }, 503);
        await env.WEBHOOK_STATE.put("revoked", "false");
        return jsonResponse({ reset: true });
      }
      return jsonResponse({ error: "Not found." }, 404);
    } catch (error) {
      return jsonResponse({ error: `Webhook service error: ${error.message}` }, 500);
    }
  },
};

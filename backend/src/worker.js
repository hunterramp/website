const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8"
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    if (request.method === "POST" && url.pathname === "/api/resume-request") {
      return handleResumeRequest(request, env);
    }

    if (request.method === "GET" && url.pathname === "/api/resume-decision") {
      return handleResumeDecision(request, env);
    }

    return new Response("Not found", { status: 404 });
  }
};

async function handleResumeRequest(request, env) {
  try {
    assertEnv(env, [
      "APPROVAL_SIGNING_SECRET",
      "HUNTER_EMAIL",
      "RESEND_API_KEY",
      "RESEND_FROM",
      "SITE_URL"
    ]);

    const body = await request.json();
    const name = clean(body.name);
    const email = clean(body.email);
    const company = clean(body.company);
    const reason = clean(body.reason);

    if (!name || !email || !company || !reason) {
      return json({ error: "All fields are required." }, 400, request, env);
    }

    if (!isEmail(email)) {
      return json({ error: "Invalid email address." }, 400, request, env);
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const record = {
      id,
      status: "pending",
      createdAt: now,
      requester: { name, email, company, reason }
    };

    await env.RESUME_REQUESTS.put(requestKey(id), JSON.stringify(record), {
      expirationTtl: 60 * 60 * 24 * 30
    });

    const approveToken = await signToken({ id, action: "approve", exp: expiresInHours(168) }, env.APPROVAL_SIGNING_SECRET);
    const denyToken = await signToken({ id, action: "deny", exp: expiresInHours(168) }, env.APPROVAL_SIGNING_SECRET);

    const base = (env.APPROVAL_BASE_URL || new URL(request.url).origin).replace(/\/$/, "");
    const approveUrl = `${base}/api/resume-decision?token=${encodeURIComponent(approveToken)}`;
    const denyUrl = `${base}/api/resume-decision?token=${encodeURIComponent(denyToken)}`;

    await sendEmail(env, {
      to: env.HUNTER_EMAIL,
      subject: `Resume request: ${name} (${company})`,
      html: `
        <p>New resume request submitted.</p>
        <p><strong>Name:</strong> ${escapeHtml(name)}<br/>
        <strong>Email:</strong> ${escapeHtml(email)}<br/>
        <strong>Company:</strong> ${escapeHtml(company)}<br/>
        <strong>Reason:</strong><br/>${escapeHtml(reason).replace(/\n/g, "<br/>")}</p>
        <p>
          <a href="${approveUrl}" style="display:inline-block;padding:10px 14px;border-radius:8px;background:#1d4ed8;color:#fff;text-decoration:none;margin-right:8px;">Approve</a>
          <a href="${denyUrl}" style="display:inline-block;padding:10px 14px;border-radius:8px;background:#374151;color:#fff;text-decoration:none;">Deny</a>
        </p>
        <p>Links expire in 7 days.</p>
      `,
      text: [
        "New resume request submitted.",
        `Name: ${name}`,
        `Email: ${email}`,
        `Company: ${company}`,
        `Reason: ${reason}`,
        "",
        `Approve: ${approveUrl}`,
        `Deny: ${denyUrl}`,
        "",
        "Links expire in 7 days."
      ].join("\n")
    });

    return json({ ok: true }, 200, request, env);
  } catch (error) {
    return json({ error: error.message || "Unable to process request." }, 500, request, env);
  }
}

async function handleResumeDecision(request, env) {
  try {
    assertEnv(env, [
      "APPROVAL_SIGNING_SECRET",
      "RESEND_API_KEY",
      "RESEND_FROM"
    ]);

    const url = new URL(request.url);
    const token = url.searchParams.get("token") || "";
    if (!token) {
      return html("Invalid link.", 400);
    }

    const payload = await verifyToken(token, env.APPROVAL_SIGNING_SECRET);
    if (!payload || !payload.id || !payload.action) {
      return html("Invalid or expired link.", 400);
    }

    if (Date.now() > payload.exp * 1000) {
      return html("This decision link has expired.", 400);
    }

    const raw = await env.RESUME_REQUESTS.get(requestKey(payload.id));
    if (!raw) {
      return html("Request not found.", 404);
    }

    const record = JSON.parse(raw);
    if (record.status !== "pending") {
      return html(`Request already ${record.status}.`, 200);
    }

    if (payload.action === "deny") {
      record.status = "denied";
      record.decidedAt = new Date().toISOString();
      await env.RESUME_REQUESTS.put(requestKey(record.id), JSON.stringify(record), {
        expirationTtl: 60 * 60 * 24 * 30
      });
      return html("Request denied. No email sent to requester.", 200);
    }

    const resumeAttachment = await fetchResumeAttachmentFromR2(env);

    await sendEmail(env, {
      to: record.requester.email,
      bcc: env.HUNTER_EMAIL,
      subject: "Resume Request Approved - Hunter Ramp",
      html: `
        <p>Hi ${escapeHtml(record.requester.name)},</p>
        <p>Thanks for your interest. Your resume request has been approved.</p>
        <p>Please find the PDF attached.</p>
        <p>Best,<br/>Hunter Ramp</p>
      `,
      text: `Hi ${record.requester.name},\n\nThanks for your interest. Your resume request has been approved.\nPlease find the PDF attached.\n\nBest,\nHunter Ramp`,
      attachments: [resumeAttachment]
    });

    record.status = "approved";
    record.decidedAt = new Date().toISOString();
    await env.RESUME_REQUESTS.put(requestKey(record.id), JSON.stringify(record), {
      expirationTtl: 60 * 60 * 24 * 30
    });

    return html(`Approved. Resume sent to ${escapeHtml(record.requester.email)}.`, 200);
  } catch (error) {
    return html(`Error: ${escapeHtml(error.message || "Unable to process decision")}`, 500);
  }
}

function requestKey(id) {
  return `resume_request:${id}`;
}

function clean(value) {
  return String(value || "").trim();
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function expiresInHours(hours) {
  return Math.floor(Date.now() / 1000) + hours * 60 * 60;
}

function json(payload, status, request, env) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...JSON_HEADERS,
      ...corsHeaders(request, env)
    }
  });
}

function html(message, status) {
  return new Response(`<!doctype html><html><body style="font-family:system-ui;background:#0b0d12;color:#f3f4f6;padding:24px;"><h2>${message}</h2></body></html>`, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" }
  });
}

function corsHeaders(request, env) {
  const origin = request.headers.get("origin") || "";
  const allow = (env.SITE_URL || "").replace(/\/$/, "");
  if (!origin || origin.replace(/\/$/, "") === allow) {
    return {
      "access-control-allow-origin": allow || origin || "*",
      "access-control-allow-methods": "POST,GET,OPTIONS",
      "access-control-allow-headers": "content-type"
    };
  }
  return {
    "access-control-allow-origin": allow,
    "access-control-allow-methods": "POST,GET,OPTIONS",
    "access-control-allow-headers": "content-type"
  };
}

function assertEnv(env, keys) {
  keys.forEach((key) => {
    if (!env[key]) {
      throw new Error(`Missing required environment variable: ${key}`);
    }
  });
}

async function signToken(payload, secret) {
  const payloadBytes = toUtf8(JSON.stringify(payload));
  const sigBytes = await hmacSha256(payloadBytes, toUtf8(secret));
  return `${base64UrlEncode(payloadBytes)}.${base64UrlEncode(sigBytes)}`;
}

async function verifyToken(token, secret) {
  const parts = token.split(".");
  if (parts.length !== 2) {
    return null;
  }

  const payloadBytes = base64UrlDecode(parts[0]);
  const providedSig = base64UrlDecode(parts[1]);
  const expectedSig = await hmacSha256(payloadBytes, toUtf8(secret));

  if (!timingSafeEqual(providedSig, expectedSig)) {
    return null;
  }

  const json = new TextDecoder().decode(payloadBytes);
  return JSON.parse(json);
}

async function hmacSha256(messageBytes, secretBytes) {
  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, messageBytes);
  return new Uint8Array(sig);
}

function toUtf8(value) {
  return new TextEncoder().encode(value);
}

function base64UrlEncode(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) {
    return false;
  }
  let out = 0;
  for (let i = 0; i < a.length; i += 1) {
    out |= a[i] ^ b[i];
  }
  return out === 0;
}

async function fetchResumeAttachmentFromR2(env) {
  if (!env.RESUME_FILES) {
    throw new Error("Missing RESUME_FILES R2 binding.");
  }

  const key = env.RESUME_PDF_KEY || "Hunter-Ramp-Resume.pdf";
  const object = await env.RESUME_FILES.get(key);
  if (!object) {
    throw new Error(`Resume PDF not found in R2 at key: ${key}`);
  }

  const bytes = new Uint8Array(await object.arrayBuffer());
  return {
    filename: key.split("/").pop() || "Hunter-Ramp-Resume.pdf",
    content: bytesToBase64(bytes)
  };
}

function bytesToBase64(bytes) {
  const chunk = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, i + chunk);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

async function sendEmail(env, { to, subject, html, text, attachments, bcc }) {
  const payload = {
    from: env.RESEND_FROM,
    to,
    subject,
    html,
    text
  };

  if (attachments && attachments.length) {
    payload.attachments = attachments;
  }

  if (bcc) {
    payload.bcc = bcc;
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Email send failed: ${response.status} ${message}`);
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

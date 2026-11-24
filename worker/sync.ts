export interface SyncEnv {
  DB: D1Database;
  BLOBS: KVNamespace;
  ASSETS: Fetcher;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS, PATCH",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, If-Match",
  "Access-Control-Expose-Headers": "ETag",
};

function json(data: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json");
  for (const [k, v] of Object.entries(CORS_HEADERS)) {
    headers.set(k, v);
  }
  return new Response(JSON.stringify(data), {
    ...init,
    headers,
  });
}

function err(status: number, code: string, message: string, extra?: Record<string, unknown>): Response {
  return json({ error: { code, message, ...extra } }, { status });
}

interface AccountRecord {
  id: string;
  email: string;
  display_name: string | null;
  created_at: string;
  token: string;
}

async function getAccount(request: Request, db: D1Database): Promise<AccountRecord | null> {
  const auth = request.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  const token = auth.slice(7).trim();
  if (!token) return null;
  const row = await db
    .prepare(
      "SELECT a.id, a.email, a.display_name, a.created_at, t.token FROM device_tokens t JOIN accounts a ON t.account_id = a.id WHERE t.token = ?"
    )
    .bind(token)
    .first<AccountRecord>();
  return row ?? null;
}

export async function handleSyncRequest(request: Request, env: SyncEnv): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // 1. Server discovery
  if (path === "/v1/server" && method === "GET") {
    return json({
      billing: false,
      market: false,
      quotaBytes: 1024 * 1024 * 1024,
      passkeys: { rpId: "" },
      sync: { withoutPassword: false },
    });
  }

  // 2. Auth: start email sign-in
  if (path === "/v1/auth/email/start" && method === "POST") {
    const body = (await request.json().catch(() => ({}))) as { email?: string };
    const email = body.email?.trim()?.toLowerCase();
    if (!email || !email.includes("@")) {
      return err(400, "invalid_email", "Enter a valid email address");
    }
    const code = "123456";
    const expiresAt = Date.now() + 15 * 60 * 1000;
    await env.DB.prepare(
      "INSERT OR REPLACE INTO auth_codes (email, code, expires_at) VALUES (?, ?, ?)"
    )
      .bind(email, code, expiresAt)
      .run();
    return json({ ok: true });
  }

  // 3. Auth: verify code or token
  if (path === "/v1/auth/email/verify" && method === "POST") {
    const body = (await request.json().catch(() => ({}))) as {
      email?: string;
      code?: string;
      token?: string;
      deviceName?: string;
    };
    const email = body.email?.trim()?.toLowerCase();
    const code = body.code?.trim() || body.token?.trim();
    if (!email) {
      return err(400, "invalid_email", "Email address is required");
    }
    if (!code) {
      return err(400, "invalid_code", "Verification code is required");
    }

    const authRecord = await env.DB.prepare(
      "SELECT code, expires_at FROM auth_codes WHERE email = ?"
    )
      .bind(email)
      .first<{ code: string; expires_at: number }>();

    // Accept recorded code (or standard 123456 fallback for self-hosted)
    if (authRecord && authRecord.code !== code && code !== "123456") {
      return err(400, "invalid_code", "Invalid verification code");
    }

    let acc = await env.DB.prepare("SELECT id, email, display_name FROM accounts WHERE email = ?")
      .bind(email)
      .first<{ id: string; email: string; display_name: string | null }>();

    if (!acc) {
      const id = "acc_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
      const name = email.split("@")[0];
      await env.DB.prepare(
        "INSERT INTO accounts (id, email, display_name, created_at) VALUES (?, ?, ?, ?)"
      )
        .bind(id, email, name, new Date().toISOString())
        .run();
      acc = { id, email, display_name: name };
    }

    const deviceToken = "etd_" + crypto.randomUUID().replace(/-/g, "");
    const deviceName = body.deviceName?.trim() || "Cloudflare Device";
    await env.DB.prepare(
      "INSERT INTO device_tokens (token, account_id, device_name, created_at) VALUES (?, ?, ?, ?)"
    )
      .bind(deviceToken, acc.id, deviceName, new Date().toISOString())
      .run();

    return json({
      token: deviceToken,
      account: {
        id: acc.id,
        email: acc.email,
        displayName: acc.display_name ?? acc.email.split("@")[0],
        sync: { active: true, plan: "self-hosted" },
      },
    });
  }

  // Auth required for remaining endpoints
  const account = await getAccount(request, env.DB);
  if (!account) {
    return err(401, "unauthorized", "Sign in first");
  }

  // 4. Current user info
  if (path === "/v1/me" && method === "GET") {
    return json({
      id: account.id,
      email: account.email,
      displayName: account.display_name ?? account.email.split("@")[0],
      created: account.created_at,
      sync: { active: true, plan: "self-hosted" },
    });
  }

  // 5. Billing info
  if (path === "/v1/billing/sync" && method === "GET") {
    return json({ active: true, plan: "self-hosted" });
  }

  // 6. Logout
  if (path === "/v1/auth/logout" && method === "POST") {
    await env.DB.prepare("DELETE FROM device_tokens WHERE token = ?").bind(account.token).run();
    return json({ ok: true });
  }

  // 6b. Passkeys, devices, and library (self-hosted stubs / device list)
  if (path === "/v1/me/passkeys" && method === "GET") {
    return json({ passkeys: [] });
  }

  if (path === "/v1/library" && method === "GET") {
    return json({ library: [], revoked: [] });
  }

  if (path === "/v1/creator" && method === "GET") {
    return err(404, "not_creator", "Not a creator");
  }

  if (path === "/v1/listings" && method === "GET") {
    return json({ listings: [] });
  }

  if (path === "/v1/creator/sales" && method === "GET") {
    return json({ sales: [] });
  }

  if (path === "/v1/devices" && method === "GET") {
    const rows = await env.DB.prepare(
      "SELECT token, device_name, created_at FROM device_tokens WHERE account_id = ? ORDER BY created_at DESC"
    )
      .bind(account.id)
      .all<{ token: string; device_name: string | null; created_at: string }>();
    return json({
      devices: (rows.results ?? []).map((r) => ({
        id: r.token,
        name: r.device_name ?? "Device",
        created: r.created_at,
        lastSeen: r.created_at,
        via: "email",
        current: r.token === account.token,
      })),
    });
  }

  if (path.startsWith("/v1/devices/") && method === "DELETE") {
    const id = decodeURIComponent(path.slice("/v1/devices/".length));
    await env.DB.prepare("DELETE FROM device_tokens WHERE token = ? AND account_id = ?")
      .bind(id, account.id)
      .run();
    return json({ ok: true, self: id === account.token });
  }

  // 7. Vault status & usage
  if (path === "/v1/vault" && method === "GET") {
    const vk = await env.DB.prepare("SELECT keys_json FROM vault_keys WHERE account_id = ?")
      .bind(account.id)
      .first<{ keys_json: string }>();
    const usage = await env.DB.prepare(
      "SELECT COALESCE(SUM(size), 0) AS total FROM blob_meta WHERE account_id = ?"
    )
      .bind(account.id)
      .first<{ total: number }>();
    return json({
      hasKeys: !!vk,
      mode: vk ? "password" : null,
      usedBytes: Number(usage?.total ?? 0),
    });
  }

  // 8. Vault keys
  if (path === "/v1/vault/keys") {
    if (method === "GET") {
      const row = await env.DB.prepare(
        "SELECT keys_json, etag FROM vault_keys WHERE account_id = ?"
      )
        .bind(account.id)
        .first<{ keys_json: string; etag: number }>();
      if (!row) return err(404, "no_keys", "No vault keys found");
      const etag = `"k${row.etag}"`;
      return json(JSON.parse(row.keys_json), { headers: { ETag: etag } });
    }
    if (method === "PUT") {
      const current = await env.DB.prepare(
        "SELECT etag FROM vault_keys WHERE account_id = ?"
      )
        .bind(account.id)
        .first<{ etag: number }>();
      const ifMatch = request.headers.get("if-match");
      if (current) {
        const curEtag = `"k${current.etag}"`;
        if (ifMatch && ifMatch !== curEtag) {
          return err(412, "etag_mismatch", "ETag mismatch on vault keys");
        }
      }
      const nextEtag = (current?.etag ?? 0) + 1;
      const body = await request.json();
      await env.DB.prepare(
        "INSERT OR REPLACE INTO vault_keys (account_id, keys_json, etag, updated_at) VALUES (?, ?, ?, ?)"
      )
        .bind(account.id, JSON.stringify(body), nextEtag, new Date().toISOString())
        .run();
      const etag = `"k${nextEtag}"`;
      return json({ ok: true, etag }, { headers: { ETag: etag } });
    }
  }

  // 9. Vault snapshot
  if (path === "/v1/vault/snapshot") {
    if (method === "GET") {
      const row = await env.DB.prepare(
        "SELECT snapshot_id, seq, parts_json, size, etag FROM vault_snapshot WHERE account_id = ?"
      )
        .bind(account.id)
        .first<{ snapshot_id: string; seq: number; parts_json: string; size: number; etag: number }>();
      if (!row) return err(404, "no_snapshot", "No snapshot found");
      const etag = `"s${row.etag}"`;
      return json(
        {
          v: 1,
          id: row.snapshot_id,
          seq: row.seq,
          parts: JSON.parse(row.parts_json),
          size: row.size,
        },
        { headers: { ETag: etag } }
      );
    }
    if (method === "PUT") {
      const current = await env.DB.prepare(
        "SELECT seq, parts_json, etag FROM vault_snapshot WHERE account_id = ?"
      )
        .bind(account.id)
        .first<{ seq: number; parts_json: string; etag: number }>();
      const ifMatch = request.headers.get("if-match");
      if (current) {
        const curEtag = `"s${current.etag}"`;
        if (ifMatch && ifMatch !== curEtag) return err(412, "etag_mismatch", "ETag mismatch");
      }
      const body = (await request.json()) as { id: string; seq: number; parts: string[] };
      if (current && body.seq <= current.seq) {
        return err(409, "not_newer", "Snapshot is not newer than current");
      }

      // Compute size of parts
      let totalSize = 0;
      for (const p of body.parts) {
        const meta = await env.DB.prepare(
          "SELECT size FROM blob_meta WHERE account_id = ? AND name = ?"
        )
          .bind(account.id, p)
          .first<{ size: number }>();
        totalSize += meta?.size ?? 0;
      }

      const nextEtag = (current?.etag ?? 0) + 1;
      await env.DB.prepare(
        "INSERT OR REPLACE INTO vault_snapshot (account_id, snapshot_id, seq, parts_json, size, etag, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
        .bind(
          account.id,
          body.id,
          body.seq,
          JSON.stringify(body.parts),
          totalSize,
          nextEtag,
          new Date().toISOString()
        )
        .run();

      // Clean up old snapshot parts no longer referenced
      if (current) {
        const oldParts: string[] = JSON.parse(current.parts_json);
        for (const op of oldParts) {
          if (!body.parts.includes(op)) {
            await env.BLOBS.delete(op);
            await env.DB.prepare(
              "DELETE FROM blob_meta WHERE account_id = ? AND name = ?"
            )
              .bind(account.id, op)
              .run();
          }
        }
      }

      const etag = `"s${nextEtag}"`;
      return json({ ok: true, etag }, { headers: { ETag: etag } });
    }
  }

  // 10. Sync events
  if (path === "/v1/sync/events") {
    if (method === "POST") {
      const body = (await request.json()) as {
        events?: Array<{ id: string; ciphertext: string }>;
      };
      const events = body.events ?? [];
      const maxRow = await env.DB.prepare(
        "SELECT COALESCE(MAX(seq), 0) AS max_seq FROM sync_events WHERE account_id = ?"
      )
        .bind(account.id)
        .first<{ max_seq: number }>();
      let curSeq = Number(maxRow?.max_seq ?? 0);
      const now = new Date().toISOString();

      if (events.length > 0) {
        const statements: D1PreparedStatement[] = [];
        for (const e of events) {
          curSeq++;
          statements.push(
            env.DB.prepare(
              "INSERT INTO sync_events (account_id, seq, id, ciphertext, device_token, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(account_id, id) DO NOTHING"
            ).bind(account.id, curSeq, e.id, e.ciphertext, account.token, now)
          );
        }
        await env.DB.batch(statements);
      }

      const finalRow = await env.DB.prepare(
        "SELECT COALESCE(MAX(seq), 0) AS max_seq FROM sync_events WHERE account_id = ?"
      )
        .bind(account.id)
        .first<{ max_seq: number }>();

      return json({
        accepted: events.length,
        duplicates: 0,
        lastSeq: Number(finalRow?.max_seq ?? curSeq),
      });
    }

    if (method === "GET") {
      const after = Number(url.searchParams.get("after") ?? 0);
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 1000), 1000);
      const rows = await env.DB.prepare(
        "SELECT seq, id, ciphertext, created_at FROM sync_events WHERE account_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?"
      )
        .bind(account.id, after, limit + 1)
        .all<{ seq: number; id: string; ciphertext: string; created_at: string }>();

      const results = rows.results ?? [];
      const page = results.slice(0, limit);
      const more = results.length > limit;
      const cursor = page.length ? page[page.length - 1].seq : after;

      return json({
        events: page.map((r) => ({
          seq: r.seq,
          id: r.id,
          ciphertext: r.ciphertext,
          at: r.created_at,
        })),
        cursor: String(cursor),
        more,
      });
    }
  }

  // 11. Blobs: PUT / GET / DELETE /v1/blobs/:name
  if (path.startsWith("/v1/blobs/")) {
    const name = path.slice("/v1/blobs/".length);
    if (!/^[a-f0-9]{64}$/.test(name)) {
      return err(400, "invalid_blob_name", "Invalid blob name format");
    }

    if (method === "PUT") {
      const bytes = await request.arrayBuffer();
      await env.BLOBS.put(name, bytes);
      await env.DB.prepare(
        "INSERT OR REPLACE INTO blob_meta (account_id, name, size, created_at) VALUES (?, ?, ?, ?)"
      )
        .bind(account.id, name, bytes.byteLength, new Date().toISOString())
        .run();
      return json({ ok: true, hash: name }, { status: 201 });
    }

    if (method === "GET") {
      const bytes = await env.BLOBS.get(name, { type: "arrayBuffer" });
      if (!bytes) return err(404, "not_found", "Blob not found");
      return new Response(bytes, {
        status: 200,
        headers: {
          "Content-Type": "application/octet-stream",
          "Cache-Control": "public, max-age=31536000, immutable",
          ...CORS_HEADERS,
        },
      });
    }

    if (method === "DELETE") {
      const snap = await env.DB.prepare(
        "SELECT parts_json FROM vault_snapshot WHERE account_id = ?"
      )
        .bind(account.id)
        .first<{ parts_json: string }>();
      if (snap) {
        const parts: string[] = JSON.parse(snap.parts_json);
        if (parts.includes(name)) {
          return err(409, "in_snapshot", "Cannot delete blob that is part of a snapshot");
        }
      }
      await env.BLOBS.delete(name);
      await env.DB.prepare(
        "DELETE FROM blob_meta WHERE account_id = ? AND name = ?"
      )
        .bind(account.id, name)
        .run();
      return json({ ok: true });
    }
  }

  return err(404, "not_found", `Route ${method} ${path} not found`);
}

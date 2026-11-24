import { handleSyncRequest, type SyncEnv } from "./sync.ts";

export interface Env extends SyncEnv {}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Route /v1/* API requests directly to the self-hosted Etude sync backend
    if (url.pathname.startsWith("/v1/")) {
      return handleSyncRequest(request, env);
    }

    // Fetch matching file from Cloudflare Workers Static Assets
    let response = await env.ASSETS.fetch(request);

    // If not found and this is a page navigation, fallback to index.html for SPA routing
    if (response.status === 404 && request.method === "GET" && !url.pathname.includes(".")) {
      const indexRequest = new Request(new URL("/", request.url), request);
      response = await env.ASSETS.fetch(indexRequest);
    }

    if (!response) {
      return new Response("Not found", { status: 404 });
    }

    const headers = new Headers(response.headers);

    // Required for SQLite WASM OPFS and Web Worker isolation
    headers.set("Cross-Origin-Opener-Policy", "same-origin");
    headers.set("Cross-Origin-Embedder-Policy", "require-corp");

    // Cache static immutable assets aggressively; keep HTML and manifests fresh
    if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/kit/") || url.pathname.startsWith("/fonts/")) {
      headers.set("Cache-Control", "public, max-age=31536000, immutable");
    } else if (url.pathname.endsWith(".html") || url.pathname === "/" || url.pathname.endsWith(".webmanifest")) {
      headers.set("Cache-Control", "no-cache");
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};

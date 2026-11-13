import { createServer } from "node:http";
import { nearest, dataInfo } from "./nearest.mjs";

// --- Configuration (environment variables) ---
const PORT = Number(process.env.PORT) || 8080;
// Bind to localhost by default; put a reverse proxy (HTTPS) in front.
// The Dockerfile sets HOST=0.0.0.0 because the container is the boundary there.
const HOST = process.env.HOST || "127.0.0.1";
// Requests per IP per minute. 0 disables rate limiting.
const RATE_LIMIT = process.env.RATE_LIMIT_PER_MIN === undefined ? 600 : Number(process.env.RATE_LIMIT_PER_MIN);
// Set to 1 only when behind a reverse proxy you control that sets X-Forwarded-For;
// otherwise clients could spoof their IP to dodge the rate limit.
const TRUST_PROXY = process.env.TRUST_PROXY === "1";

const USAGE = "GET /nearest/{lat},{lon}";
// Plain decimal degrees only: no exponents, hex, Infinity, or absurd precision.
const NUM = String.raw`-?\d{1,3}(?:\.\d{1,10})?`;
const PATH_COORDS = new RegExp(`^/nearest/(${NUM}),(${NUM})$`);
const ONE_NUM = new RegExp(`^${NUM}$`);

const SECURITY_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "cross-origin",
};

function send(req, res, status, body, extraHeaders = {}) {
  const payload = body === null ? "" : JSON.stringify(body, null, 2) + "\n";
  const headers = { ...SECURITY_HEADERS, ...extraHeaders };
  if (payload) {
    headers["Content-Type"] = "application/json; charset=utf-8";
    headers["Content-Length"] = Buffer.byteLength(payload);
  }
  res.writeHead(status, headers);
  res.end(req.method === "HEAD" ? undefined : payload);
}

/** Returns [lat, lon], or null if the request has no valid coordinates. */
export function parseCoords(path, search) {
  let lat, lon;
  const m = path.match(PATH_COORDS);
  if (m) {
    [lat, lon] = [m[1], m[2]];
  } else if (path === "/nearest") {
    const q = new URLSearchParams(search);
    [lat, lon] = [q.get("lat"), q.get("lon")];
    if (!ONE_NUM.test(lat ?? "") || !ONE_NUM.test(lon ?? "")) return null;
  } else {
    return null;
  }
  [lat, lon] = [Number(lat), Number(lon)];
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return [lat, lon];
}

// --- Rate limiting: fixed one-minute window per client IP, kept in memory ---
const hits = new Map();
let windowStart = Date.now();
function rateLimited(req) {
  if (!RATE_LIMIT) return false;
  const now = Date.now();
  if (now - windowStart >= 60_000) { hits.clear(); windowStart = now; }
  let ip = req.socket.remoteAddress || "unknown";
  if (TRUST_PROXY) {
    // Use the address the proxy appended (the last entry), not client-supplied ones.
    const xff = String(req.headers["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (xff.length) ip = xff[xff.length - 1];
  }
  const n = (hits.get(ip) || 0) + 1;
  hits.set(ip, n);
  return n > RATE_LIMIT;
}

function handle(req, res) {
  if (req.method === "OPTIONS") {
    return send(req, res, 204, null, { "Access-Control-Allow-Methods": "GET, HEAD", "Access-Control-Max-Age": "86400" });
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    return send(req, res, 405, { error: "Method not allowed", usage: USAGE }, { Allow: "GET, HEAD, OPTIONS" });
  }

  // Never decode the path: coordinates need no escaping, so anything with
  // % escapes or other odd characters simply fails the pattern below.
  const raw = req.url || "/";
  const q = raw.indexOf("?");
  const path = q === -1 ? raw : raw.slice(0, q);
  const search = q === -1 ? "" : raw.slice(q + 1);

  if (path === "/" || path === "/health") {
    return send(req, res, 200, { status: "ok", usage: USAGE, data: dataInfo }, { "Cache-Control": "no-store" });
  }
  if (path === "/nearest" || path.startsWith("/nearest/")) {
    if (rateLimited(req)) {
      const retry = Math.max(1, Math.ceil((windowStart + 60_000 - Date.now()) / 1000));
      return send(req, res, 429, { error: "Too many requests" }, { "Retry-After": String(retry) });
    }
    const coords = parseCoords(path, search);
    if (!coords) return send(req, res, 400, { error: "Expected /nearest/{lat},{lon} in decimal degrees, lat in [-90, 90], lon in [-180, 180]" });
    return send(req, res, 200, nearest(...coords), { "Cache-Control": "public, max-age=86400" });
  }
  send(req, res, 404, { error: "Not found", usage: USAGE });
}

export const server = createServer(
  {
    maxHeaderSize: 8 * 1024, // the API needs no large headers or cookies
    connectionsCheckingInterval: 2_000, // how often the timeouts below are enforced
  },
  (req, res) => {
    try {
      handle(req, res);
    } catch (err) {
      // Log the details server-side; never send them to the client.
      console.error(new Date().toISOString(), "request failed:", req.method, JSON.stringify(req.url), err);
      if (!res.headersSent) send(req, res, 500, { error: "Internal server error" });
      else res.destroy();
    }
  },
);

// Drop slow or idle clients quickly (slowloris-style connection hogging).
server.headersTimeout = 10_000;
server.requestTimeout = 15_000;
server.keepAliveTimeout = 5_000;
server.maxRequestsPerSocket = 1000;
server.on("clientError", (err, socket) => {
  const status =
    err.code === "HPE_HEADER_OVERFLOW" ? "431 Request Header Fields Too Large"
    : err.code === "ERR_HTTP_REQUEST_TIMEOUT" ? "408 Request Timeout"
    : "400 Bad Request";
  if (socket.writable) socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
  else socket.destroy();
});

if (import.meta.url === `file://${process.argv[1]}`) {
  server.listen(PORT, HOST, () => {
    console.log(`nearest-town API listening on http://${HOST}:${PORT} (${dataInfo.count} places, ${dataInfo.boundaries} boundaries; rate limit ${RATE_LIMIT ? `${RATE_LIMIT}/min per IP` : "off"}${TRUST_PROXY ? ", trusting X-Forwarded-For" : ""})`);
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

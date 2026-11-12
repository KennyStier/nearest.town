import { createServer } from "node:http";
import { nearest, dataInfo } from "./nearest.mjs";

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || "0.0.0.0";

const COORD = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;

function send(res, status, body, extraHeaders = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    ...extraHeaders,
  });
  res.end(JSON.stringify(body, null, 2) + "\n");
}

function parseCoords(url) {
  // /nearest/39.2375,-85.4619  or  /nearest?lat=39.2375&lon=-85.4619
  const path = decodeURIComponent(url.pathname.slice("/nearest".length).replace(/^\//, ""));
  let lat, lon;
  const m = path.match(COORD);
  if (m) [lat, lon] = [Number(m[1]), Number(m[2])];
  else if (!path) [lat, lon] = [url.searchParams.get("lat"), url.searchParams.get("lon")].map((v) => (v === null || v.trim() === "" ? NaN : Number(v)));
  else return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return [lat, lon];
}

export const server = createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "OPTIONS") return send(res, 204, null, { "Access-Control-Allow-Methods": "GET", "Access-Control-Max-Age": "86400" });
  if (req.method !== "GET") return send(res, 405, { error: "Only GET is supported" });

  if (url.pathname === "/" || url.pathname === "/health") {
    return send(res, 200, { status: "ok", usage: "GET /nearest/{lat},{lon}", data: dataInfo });
  }
  if (url.pathname === "/nearest" || url.pathname.startsWith("/nearest/")) {
    const coords = parseCoords(url);
    if (!coords) return send(res, 400, { error: "Expected /nearest/{lat},{lon} with lat in [-90, 90] and lon in [-180, 180]" });
    return send(res, 200, nearest(...coords), { "Cache-Control": "public, max-age=86400" });
  }
  send(res, 404, { error: "Not found", usage: "GET /nearest/{lat},{lon}" });
});

if (import.meta.url === `file://${process.argv[1]}`) {
  server.listen(PORT, HOST, () => console.log(`nearest-town API listening on http://${HOST}:${PORT} (${dataInfo.count} places, ${dataInfo.source})`));
}

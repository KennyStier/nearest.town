import { test } from "node:test";
import assert from "node:assert/strict";
import { nearest, cardinal } from "./nearest.mjs";
import net from "node:net";

// Low limit so the rate-limit test is quick; must be set before server.mjs loads.
process.env.RATE_LIMIT_PER_MIN = "60";
const { server } = await import("./server.mjs");

// Expected values are distances to the Census Gazetteer center points.
// [lat, lon, town, state, miles from center, direction from center, inside town?]
const cases = [
  [39.237535, -85.461877, "Millhousen", "IN", 2.31, "NW", false],
  [39.258965, -85.526522, "Letts", "IN", 2.83, "NE", false],
  [39.443466, -85.570486, "St. Omer", "IN", 1.37, "ENE", false],
  [39.401432, -85.639284, "St. Paul", "IN", 1.93, "SSW", false],
  [41.8781, -87.6298, "Chicago", "IL", 4.01, "NE", true],
  [36.1627, -86.7816, "Nashville", "TN", 0.66, "SSE", true],
  // Newport KY's center is closer, but the ballpark is inside Cincinnati.
  [39.097197, -84.506497, "Cincinnati", "OH", 2.97, "S", true],
  [39.0912, -84.4958, "Newport", "KY", 0.6, "NW", true],
  // Nearest center is Point MacKenzie, but this is inside Anchorage.
  [61.2181, -149.9003, "Anchorage", "AK", 20.73, "W", true],
];

for (const [lat, lon, name, state, miles, dir, inside] of cases) {
  test(`${lat},${lon} -> ${name}, ${state}`, () => {
    const r = nearest(lat, lon);
    assert.equal(r.town.name, name);
    assert.equal(r.town.state, state);
    assert.ok(Math.abs(r.distance.miles - miles) < 0.02, `miles ${r.distance.miles} vs ${miles}`);
    assert.equal(r.direction, dir);
    assert.equal(r.inside, inside);
    assert.equal(r.text, `${miles.toFixed(1)} miles ${dir} of ${name}, ${state}`);
  });
}

test("a town's own center is 0 miles away", () => {
  const r = nearest(39.211988, -85.434165);
  assert.equal(r.town.name, "Millhousen");
  assert.equal(r.distance.meters, 0);
  assert.equal(r.inside, true);
  assert.equal(r.text, "0.0 miles N of Millhousen, IN");
});

test("cardinal directions wrap correctly", () => {
  assert.equal(cardinal(0), "N");
  assert.equal(cardinal(11), "N");
  assert.equal(cardinal(12), "NNE");
  assert.equal(cardinal(359), "N");
  assert.equal(cardinal(315), "NW");
});

// Send raw bytes, bypassing fetch's URL normalization; returns the status line.
function raw(port, request) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1", () => sock.write(request));
    let data = "";
    sock.on("data", (d) => (data += d));
    sock.on("end", () => resolve(data.split("\r\n")[0]));
    sock.on("error", reject);
  });
}

test("HTTP routes and hardening", async (t) => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const req = async (p, init) => { const res = await fetch(base + p, init); const text = await res.text(); return [res.status, text ? JSON.parse(text) : null, res.headers, text]; };

  let [status, body, headers] = await req("/nearest/39.237535,-85.461877");
  assert.equal(status, 200);
  assert.equal(body.text, "2.3 miles NW of Millhousen, IN");
  assert.equal(headers.get("access-control-allow-origin"), "*");
  assert.equal(headers.get("x-content-type-options"), "nosniff");
  assert.match(headers.get("content-security-policy"), /default-src 'none'/);

  [status, body] = await req("/nearest?lat=39.237535&lon=-85.461877");
  assert.equal(status, 200);
  assert.equal(body.town.name, "Millhousen");

  const bad = [
    "/nearest/abc", "/nearest/91,0", "/nearest/0,181", "/nearest", "/nearest?lat=1",
    "/nearest?lat=0x10&lon=5", "/nearest?lat=1e1&lon=5", "/nearest?lat=Infinity&lon=5",
    "/nearest?lat=&lon=", "/nearest/39.2,-85.4/extra", "/nearest/39.2,-85.4,1",
    "/nearest/1." + "1".repeat(50) + ",2", "/nearest/%33%39,-85",
  ];
  for (const p of bad) {
    [status] = await req(p);
    assert.equal(status, 400, p);
  }
  [status] = await req("/nope");
  assert.equal(status, 404);

  // A malformed %-escape used to throw in decodeURIComponent and crash the process.
  assert.match(await raw(port, "GET /nearest/%E0%A4%A HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"), / 400 /);
  assert.match(await raw(port, "GET /%ZZ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"), / 404 /);
  // Garbage request line and oversized headers are rejected at the HTTP layer.
  assert.match(await raw(port, "NOT A REQUEST\r\n\r\n"), / 400 /);
  assert.match(await raw(port, `GET /health HTTP/1.1\r\nHost: x\r\nX-Big: ${"a".repeat(10_000)}\r\nConnection: close\r\n\r\n`), / 431 /);

  [status, , headers] = await req("/health", { method: "POST", body: "x" });
  assert.equal(status, 405);
  assert.equal(headers.get("allow"), "GET, HEAD, OPTIONS");
  let text;
  [status, , headers, text] = await req("/health", { method: "OPTIONS" });
  assert.equal(status, 204);
  assert.equal(text, "");
  [status, , , text] = await req("/nearest/39.2,-85.4", { method: "HEAD" });
  assert.equal(status, 200);
  assert.equal(text, "");

  [status, body] = await req("/health");
  assert.equal(body.status, "ok");
  assert.equal(body.data.boundaries, body.data.count);

  // Still serving after all of the above.
  [status] = await req("/nearest/39.2,-85.4");
  assert.equal(status, 200);

  // Rate limit (60/min in tests): keep going until we get a 429.
  let limited = null;
  for (let i = 0; i < 80 && !limited; i++) {
    const res = await fetch(base + "/nearest/39.2,-85.4");
    await res.text();
    if (res.status === 429) limited = res;
  }
  assert.ok(limited, "expected a 429 within 80 requests");
  assert.ok(Number(limited.headers.get("retry-after")) >= 1);
  [status] = await req("/health"); // health checks aren't rate limited
  assert.equal(status, 200);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { nearest, cardinal } from "./nearest.mjs";
import { server } from "./server.mjs";

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

test("HTTP routes", async (t) => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (p) => { const res = await fetch(base + p); return [res.status, await res.json(), res.headers]; };

  let [status, body, headers] = await get("/nearest/39.237535,-85.461877");
  assert.equal(status, 200);
  assert.equal(body.text, "2.3 miles NW of Millhousen, IN");
  assert.equal(headers.get("access-control-allow-origin"), "*");

  [status, body] = await get("/nearest?lat=39.237535&lon=-85.461877");
  assert.equal(status, 200);
  assert.equal(body.town.name, "Millhousen");

  for (const bad of ["/nearest/abc", "/nearest/91,0", "/nearest/0,181", "/nearest", "/nearest?lat=1"]) {
    [status] = await get(bad);
    assert.equal(status, 400, bad);
  }
  [status] = await get("/nope");
  assert.equal(status, 404);
  [status, body] = await get("/health");
  assert.equal(body.status, "ok");
});

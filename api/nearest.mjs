import { readFileSync, existsSync } from "node:fs";
import { gunzipSync } from "node:zlib";

const EARTH_RADIUS_M = 6371008.8;
const METERS_PER_MILE = 1609.344;
const DIRECTIONS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
const toRad = (d) => (d * Math.PI) / 180;

const data = JSON.parse(readFileSync(new URL("./data/places.json", import.meta.url), "utf8"));
export const dataInfo = { source: data.source, built: data.built, count: data.places.length };

// Precompute radians and cos(lat) once so each lookup is a single pass.
const places = data.places.map(([name, state, lat, lon, geoid, type]) => ({
  name, state, lat, lon, geoid, type,
  latR: toRad(lat), lonR: toRad(lon), cosLat: Math.cos(toRad(lat)),
}));

// --- Boundaries (see build-boundaries.mjs for the file format) ---
// Each place with a boundary gets `rings`: Int32Arrays of absolute (lon, lat)
// microdegree pairs, and `bbox`. A 1-degree grid maps cells to the places whose
// bbox overlaps them.
const GRID = new Map();
const cellKey = (lonDeg, latDeg) => Math.floor(lonDeg) * 1000 + Math.floor(latDeg);
const boundaryFile = new URL("./data/boundaries.bin.gz", import.meta.url);
dataInfo.boundaries = 0;
if (existsSync(boundaryFile)) {
  const buf = gunzipSync(readFileSync(boundaryFile));
  const a = new Int32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  let i = 0;
  const count = a[i++];
  for (let n = 0; n < count; n++) {
    const p = places[a[i++]];
    const ringCount = a[i++];
    const rings = [];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let r = 0; r < ringCount; r++) {
      const len = a[i++];
      const ring = new Int32Array(len * 2);
      let x = 0, y = 0;
      for (let k = 0; k < len; k++) {
        x += a[i++]; y += a[i++];
        ring[2 * k] = x; ring[2 * k + 1] = y;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
      rings.push(ring);
    }
    p.rings = rings;
    p.bbox = [minX, minY, maxX, maxY];
    for (let cx = Math.floor(minX / 1e6); cx <= Math.floor(maxX / 1e6); cx++) {
      for (let cy = Math.floor(minY / 1e6); cy <= Math.floor(maxY / 1e6); cy++) {
        const key = cellKey(cx, cy);
        if (!GRID.has(key)) GRID.set(key, []);
        GRID.get(key).push(p);
      }
    }
  }
  dataInfo.boundaries = count;
}

// Even-odd ray casting across all rings, so holes and multi-part places work.
function contains(p, x, y) {
  const [minX, minY, maxX, maxY] = p.bbox;
  if (x < minX || x > maxX || y < minY || y > maxY) return false;
  let inside = false;
  for (const ring of p.rings) {
    const n = ring.length;
    for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
      const xi = ring[i], yi = ring[i + 1], xj = ring[j], yj = ring[j + 1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/** The place whose boundary contains (lat, lon), or null. */
function containing(lat, lon) {
  const candidates = GRID.get(cellKey(lon, lat));
  if (!candidates) return null;
  const x = lon * 1e6, y = lat * 1e6;
  for (const p of candidates) if (contains(p, x, y)) return p;
  return null;
}

export function cardinal(bearing) {
  return DIRECTIONS[Math.round(bearing / 22.5) % 16];
}

function haversineH(latR, lonR, cosLat, p) {
  const sLat = Math.sin((p.latR - latR) / 2), sLon = Math.sin((p.lonR - lonR) / 2);
  return sLat * sLat + cosLat * p.cosLat * sLon * sLon;
}

/**
 * The town a point is in, or else the nearest town center. Distance and
 * direction are always measured from the town's center point.
 */
export function nearest(lat, lon) {
  const latR = toRad(lat), lonR = toRad(lon), cosLat = Math.cos(latR);
  let best = containing(lat, lon);
  const inside = best !== null;
  let bestH = inside ? haversineH(latR, lonR, cosLat, best) : Infinity;
  if (!inside) {
    for (const p of places) {
      // Haversine "h" term is monotonic in distance, so compare it directly.
      const h = haversineH(latR, lonR, cosLat, p);
      if (h < bestH) { bestH = h; best = p; }
    }
  }
  const meters = 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(Math.min(1, bestH)));

  // Bearing from the town center to the query point ("X miles NW of Town").
  const dLon = lonR - best.lonR;
  const y = Math.sin(dLon) * cosLat;
  const x = best.cosLat * Math.sin(latR) - Math.sin(best.latR) * cosLat * Math.cos(dLon);
  const bearing = meters < 1 ? 0 : ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;

  const miles = meters / METERS_PER_MILE;
  return {
    query: { lat, lon },
    town: { name: best.name, state: best.state, type: best.type, geoid: best.geoid, lat: best.lat, lon: best.lon },
    inside,
    distance: { meters: Math.round(meters), miles: Math.round(miles * 100) / 100 },
    bearing: Math.round(bearing),
    direction: cardinal(bearing),
    text: `${miles.toFixed(1)} miles ${cardinal(bearing)} of ${best.name}, ${best.state}`,
  };
}

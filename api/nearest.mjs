import { readFileSync } from "node:fs";

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

export function cardinal(bearing) {
  return DIRECTIONS[Math.round(bearing / 22.5) % 16];
}

/** Nearest Census place center to (lat, lon), with distance and direction from that center. */
export function nearest(lat, lon) {
  const latR = toRad(lat), lonR = toRad(lon), cosLat = Math.cos(latR);
  let best = null, bestH = Infinity;
  for (const p of places) {
    // Haversine "h" term is monotonic in distance, so compare it directly.
    const sLat = Math.sin((p.latR - latR) / 2), sLon = Math.sin((p.lonR - lonR) / 2);
    const h = sLat * sLat + cosLat * p.cosLat * sLon * sLon;
    if (h < bestH) { bestH = h; best = p; }
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
    distance: { meters: Math.round(meters), miles: Math.round(miles * 100) / 100 },
    bearing: Math.round(bearing),
    direction: cardinal(bearing),
    text: `${miles.toFixed(1)} miles ${cardinal(bearing)} of ${best.name}, ${best.state}`,
  };
}

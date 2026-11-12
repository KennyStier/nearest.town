// Builds data/boundaries.bin.gz from the Census cartographic boundary file for places
// (cb_YYYY_us_place_500k), so the API can tell which town a point is inside.
//
//   node build-boundaries.mjs            # downloads the default vintage
//   node build-boundaries.mjs 2025
//   node build-boundaries.mjs path/to/cb_2025_us_place_500k.zip
//
// Run build-data.mjs first: boundaries are matched to data/places.json by GEOID.
// Requires `unzip` on PATH.
//
// Output format (gzip of little-endian int32s):
//   placeCount, then per place: placeIndex, ringCount, then per ring:
//   pointCount, then pointCount (lon, lat) pairs in microdegrees, each pair
//   stored as the difference from the previous pair in the ring.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_YEAR = "2025";
const here = dirname(fileURLToPath(import.meta.url));
const arg = process.argv[2] ?? DEFAULT_YEAR;

const dir = mkdtempSync(join(tmpdir(), "cb-place-"));
let zip = arg;
if (!existsSync(arg)) {
  const url = `https://www2.census.gov/geo/tiger/GENZ${arg}/shp/cb_${arg}_us_place_500k.zip`;
  console.log(`Downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  zip = join(dir, "places.zip");
  writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
}
execFileSync("unzip", ["-oq", zip, "*.shp", "*.dbf", "-d", dir]);
const base = execFileSync("ls", [dir], { encoding: "utf8" }).split("\n").find((f) => f.endsWith(".shp")).slice(0, -4);
const shp = readFileSync(join(dir, base + ".shp"));
const dbf = readFileSync(join(dir, base + ".dbf"));
rmSync(dir, { recursive: true, force: true });

// --- DBF: read the GEOID column ---
const nRecords = dbf.readUInt32LE(4), headerLen = dbf.readUInt16LE(8), recordLen = dbf.readUInt16LE(10);
let geoidOffset = -1, geoidLen = 0;
for (let off = 32, fieldPos = 1; dbf[off] !== 0x0d; off += 32) {
  const name = dbf.toString("latin1", off, off + 11).replace(/\0.*$/, "");
  const len = dbf[off + 16];
  if (name === "GEOID") { geoidOffset = fieldPos; geoidLen = len; }
  fieldPos += len;
}
if (geoidOffset < 0) throw new Error("GEOID field not found in DBF");
const geoids = [];
for (let i = 0; i < nRecords; i++) {
  const start = headerLen + i * recordLen + geoidOffset;
  geoids.push(dbf.toString("latin1", start, start + geoidLen).trim());
}

// --- SHP: read polygon rings ---
const shapes = [];
for (let off = 100; off < shp.length; ) {
  const contentLen = shp.readInt32BE(off + 4) * 2;
  const c = off + 8;
  const type = shp.readInt32LE(c);
  const rings = [];
  if (type === 5) {
    const numParts = shp.readInt32LE(c + 36), numPoints = shp.readInt32LE(c + 40);
    const parts = [];
    for (let p = 0; p < numParts; p++) parts.push(shp.readInt32LE(c + 44 + p * 4));
    parts.push(numPoints);
    const pts = c + 44 + numParts * 4;
    for (let p = 0; p < numParts; p++) {
      const ring = [];
      for (let k = parts[p]; k < parts[p + 1]; k++) {
        ring.push(Math.round(shp.readDoubleLE(pts + k * 16) * 1e6), Math.round(shp.readDoubleLE(pts + k * 16 + 8) * 1e6));
      }
      rings.push(ring);
    }
  } else if (type !== 0) {
    throw new Error(`Unexpected shape type ${type}`);
  }
  shapes.push(rings);
  off = c + contentLen;
}
if (shapes.length !== geoids.length) throw new Error(`SHP has ${shapes.length} shapes but DBF has ${geoids.length} records`);

// --- Join to places.json and write ---
const { places } = JSON.parse(readFileSync(join(here, "data", "places.json"), "utf8"));
const indexByGeoid = new Map(places.map((p, i) => [p[4], i]));
const out = [0];
let matched = 0, points = 0;
const unmatched = [];
shapes.forEach((rings, i) => {
  const idx = indexByGeoid.get(geoids[i]);
  if (idx === undefined) { unmatched.push(geoids[i]); return; }
  if (!rings.length) return;
  matched++;
  out.push(idx, rings.length);
  for (const ring of rings) {
    out.push(ring.length / 2);
    let px = 0, py = 0;
    for (let k = 0; k < ring.length; k += 2) {
      out.push(ring[k] - px, ring[k + 1] - py);
      px = ring[k]; py = ring[k + 1];
      points++;
    }
  }
});
out[0] = matched;

if (unmatched.length) console.warn(`${unmatched.length} boundary GEOIDs not in places.json (vintages differ?): ${unmatched.slice(0, 10).join(", ")}${unmatched.length > 10 ? ", ..." : ""}`);
const missing = places.length - matched;
if (missing) console.warn(`${missing} places have no boundary and will only be found by nearest center`);

const file = join(here, "data", "boundaries.bin.gz");
writeFileSync(file, gzipSync(Buffer.from(new Int32Array(out).buffer), { level: 9 }));
console.log(`Wrote ${matched} boundaries (${points} points) to ${file}`);

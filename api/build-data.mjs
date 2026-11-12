// Builds data/places.json from the Census Gazetteer "Places" file.
//
//   node build-data.mjs            # downloads the default vintage
//   node build-data.mjs 2025       # pick a vintage
//   node build-data.mjs path/to/2025_Gaz_place_national.txt
//
// Requires `unzip` on PATH when downloading.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_YEAR = "2025";
const here = dirname(fileURLToPath(import.meta.url));
const arg = process.argv[2] ?? DEFAULT_YEAR;

let text;
let source;
if (existsSync(arg)) {
  text = readFileSync(arg, "utf8");
  source = arg;
} else {
  const year = arg;
  source = `https://www2.census.gov/geo/docs/maps-data/data/gazetteer/${year}_Gazetteer/${year}_Gaz_place_national.zip`;
  console.log(`Downloading ${source}`);
  const res = await fetch(source);
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  const dir = mkdtempSync(join(tmpdir(), "gazetteer-"));
  const zip = join(dir, "places.zip");
  writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  text = execFileSync("unzip", ["-p", zip], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  rmSync(dir, { recursive: true, force: true });
}

// Older vintages are tab-separated, 2025+ is pipe-separated.
const lines = text.split(/\r?\n/).filter((l) => l.trim());
const sep = lines[0].includes("|") ? "|" : "\t";
const header = lines[0].split(sep).map((h) => h.trim());
const col = (name) => {
  const i = header.indexOf(name);
  if (i < 0) throw new Error(`Column ${name} not found in header: ${header.join(",")}`);
  return i;
};
const C = {
  state: col("USPS"), geoid: col("GEOID"), name: col("NAME"), lsad: col("LSAD"),
  lat: col("INTPTLAT"), lon: col("INTPTLONG"),
};

// LSAD code -> [suffix to strip from NAME, type label]
const LSAD = {
  "21": ["borough", "borough"],
  "25": ["city", "city"],
  "37": ["municipality", "municipality"],
  "43": ["town", "town"],
  "47": ["village", "village"],
  "53": ["city and borough", "city and borough"],
  "55": ["comunidad", "comunidad"],
  "57": ["CDP", "CDP"],
  "62": ["zona urbana", "zona urbana"],
};

// Consolidated city-counties and other one-offs whose official names aren't
// what anyone calls the place. Keyed by "STATE|official NAME".
const OVERRIDES = {
  "CT|Milford city (balance)": ["Milford", "city"],
  "GA|Athens-Clarke County unified government (balance)": ["Athens", "city"],
  "GA|Augusta-Richmond County consolidated government (balance)": ["Augusta", "city"],
  "GA|Cusseta-Chattahoochee County unified government": ["Cusseta", "city"],
  "GA|Echols County consolidated government": ["Echols County", "county"], // no town of that name
  "GA|Georgetown-Quitman County unified government": ["Georgetown", "city"],
  "GA|Macon-Bibb County": ["Macon", "city"],
  "GA|Webster County unified government": ["Preston", "city"], // county seat
  "IN|Indianapolis city (balance)": ["Indianapolis", "city"],
  "KS|Greeley County unified government (balance)": ["Tribune", "city"], // county seat
  "KY|Lexington-Fayette urban county": ["Lexington", "city"],
  "KY|Louisville/Jefferson County metro government (balance)": ["Louisville", "city"],
  "MT|Anaconda-Deer Lodge County": ["Anaconda", "city"],
  "MT|Butte-Silver Bow (balance)": ["Butte", "city"],
  "NV|Carson City": ["Carson City", "city"],
  "NJ|Princeton": ["Princeton", "municipality"],
  "TN|Hartsville/Trousdale County": ["Hartsville", "city"],
  "TN|Lynchburg, Moore County metropolitan government": ["Lynchburg", "city"],
  "TN|Nashville-Davidson metropolitan government (balance)": ["Nashville", "city"],
  "WV|Ranson corporation": ["Ranson", "city"],
};

const places = [];
const unhandled = [];
for (const line of lines.slice(1)) {
  const f = line.split(sep).map((v) => v.trim());
  const geoid = f[C.geoid];
  const full = f[C.name];
  const lsad = f[C.lsad];
  let name, type;
  const key = `${f[C.state]}|${full}`;
  if (OVERRIDES[key]) {
    [name, type] = OVERRIDES[key];
  } else if (LSAD[lsad] && full.endsWith(" " + LSAD[lsad][0])) {
    name = full.slice(0, -(LSAD[lsad][0].length + 1));
    type = LSAD[lsad][1];
  } else {
    name = full;
    type = "place";
    unhandled.push(`${f[C.state]} ${geoid} ${full} (LSAD ${lsad})`);
  }
  places.push([name, f[C.state], +(+f[C.lat]).toFixed(6), +(+f[C.lon]).toFixed(6), geoid, type]);
}

if (unhandled.length) {
  console.warn(`${unhandled.length} names kept as-is (add to OVERRIDES if needed):`);
  for (const u of unhandled) console.warn("  " + u);
}

const out = join(here, "data", "places.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({
  source,
  built: new Date().toISOString().slice(0, 10),
  fields: ["name", "state", "lat", "lon", "geoid", "type"],
  places,
}));
console.log(`Wrote ${places.length} places to ${out}`);

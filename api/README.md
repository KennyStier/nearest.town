# Nearest Town API

Returns the US town a latitude/longitude is in, or the nearest one if it's in no town:

1. If the point is **inside a town's boundary**, that town is returned. For example, Great American Ballpark gives Cincinnati, OH, even though Newport, KY's center point is closer.
2. Otherwise, the town with the **nearest center point** is returned. This is how the NWS `/points` API worked before late June 2026.

Distance and direction are always measured from the town's center point.

There are no dependencies: plain Node (20 or newer) and two data files in `data/`.

## Data

`data/places.json` is built from the [Census Gazetteer "Places" file](https://www.census.gov/geographies/reference-files/time-series/geo/gazetteer-files.html), currently the 2025 vintage, with about 32,000 places. NWS uses this same list. It includes:

- incorporated places (cities, towns, villages, boroughs)
- Census Designated Places (unincorporated communities)
- Puerto Rico *zonas urbanas* and *comunidades*

Each place's center is the Census **internal point**: roughly the middle of the place's land area, not necessarily its downtown.

`data/boundaries.bin.gz` holds each place's boundary from the Census [cartographic boundary file](https://www.census.gov/geographies/mapping-files/time-series/geo/cartographic-boundary.html) `cb_2025_us_place_500k` (simplified to 1:500,000 scale, about 1.9 million points). Points within a few meters of a town line can land on either side.

Names have their type suffix removed ("Millhousen town" → "Millhousen"). Consolidated city-counties get their common names ("Nashville-Davidson metropolitan government (balance)" → "Nashville"); see `OVERRIDES` in `build-data.mjs`.

To rebuild when the Census publishes a new vintage (needs `unzip`), use the same year for both files so the IDs match:

```sh
node build-data.mjs 2026 && node build-boundaries.mjs 2026
```

## Run

```sh
node server.mjs                 # listens on 0.0.0.0:8080
PORT=3000 HOST=127.0.0.1 node server.mjs
npm test
```

You can deploy with Docker (`docker build -t nearest-town-api . && docker run -p 8080:8080 nearest-town-api`) or with the example systemd unit in `nearest-town-api.service`. If you put it behind a reverse proxy, add HTTPS there.

## API

`GET /nearest/{lat},{lon}`, or `GET /nearest?lat={lat}&lon={lon}`

```json
{
  "query": { "lat": 39.237535, "lon": -85.461877 },
  "town": { "name": "Millhousen", "state": "IN", "type": "town", "geoid": "1849662", "lat": 39.211988, "lon": -85.434165 },
  "inside": false,
  "distance": { "meters": 3711, "miles": 2.31 },
  "bearing": 320,
  "direction": "NW",
  "text": "2.3 miles NW of Millhousen, IN"
}
```

- `inside` is `true` when the point is within the town's boundary. `text` is then just the name (`"Cincinnati, OH"`), but `distance`, `bearing` and `direction` are still filled in, measured from the town's center.
- `bearing` / `direction` are measured **from the town center to the query point**, as in "2.3 miles NW of Millhousen".
- Invalid coordinates return `400`.
- `GET /health` returns the status and which data file is loaded.
- Responses include `Access-Control-Allow-Origin: *` so browsers can call the API directly.
- There's no coverage limit: a point in Canada or the ocean still gets the nearest US place.

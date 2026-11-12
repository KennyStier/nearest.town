# Nearest Town API

Returns the nearest US town to a latitude/longitude. It finds the town whose center point is closest, then measures distance and direction from that center. This matches how the NWS `/points` API worked before it switched to boundary-based distances in late June 2026.

There are no dependencies: plain Node (20 or newer) and one JSON data file.

## Data

`data/places.json` is built from the [Census Gazetteer "Places" file](https://www.census.gov/geographies/reference-files/time-series/geo/gazetteer-files.html), currently the 2025 vintage, with about 32,000 places. NWS uses this same list. It includes:

- incorporated places (cities, towns, villages, boroughs)
- Census Designated Places (unincorporated communities)
- Puerto Rico *zonas urbanas* and *comunidades*

Each place's center is the Census **internal point**: roughly the middle of the place's land area, not necessarily its downtown.

Names have their type suffix removed ("Millhousen town" → "Millhousen"). Consolidated city-counties get their common names ("Nashville-Davidson metropolitan government (balance)" → "Nashville"); see `OVERRIDES` in `build-data.mjs`.

To rebuild when the Census publishes a new vintage (needs `unzip`):

```sh
node build-data.mjs 2026
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
  "distance": { "meters": 3711, "miles": 2.31 },
  "bearing": 320,
  "direction": "NW",
  "text": "2.3 miles NW of Millhousen, IN"
}
```

- `bearing` / `direction` are measured **from the town center to the query point**, as in "2.3 miles NW of Millhousen".
- Invalid coordinates return `400`.
- `GET /health` returns the status and which data file is loaded.
- Responses include `Access-Control-Allow-Origin: *` so browsers can call the API directly.
- There's no coverage limit: a point in Canada or the ocean still gets the nearest US place.
